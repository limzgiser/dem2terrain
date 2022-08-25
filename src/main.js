const gdal = require('gdal');
const os = require('os');
const { uuid } = require('./util');
const { reprojectImage } = require('./gdal-util');
const { mapboxEncode, terrariumEncode } = require('./dem-encode');
const GlobalMercator = require('./globalMercator');
const fs = require('fs');
const path = require('path');
const ProgressBar = require('./progressbar/index');
// 创建一个线程池
const workerFarm = require('worker-farm');
const workers = workerFarm(require.resolve('./createtile'), ['createTile', 'closeDataset']);

function main(inputDem, outputTile, options) {
  // 结构可选参数
  const { minZoom, maxZoom, tileSize, encoding } = options;
  console.time('地形切片生成');
  const src_ds = gdal.open(inputDem, 'r');
  const src_width = src_ds.rasterSize.x, src_height = src_ds.rasterSize.y;
  // stpe1 高程转rgb
  const height_band = src_ds.bands.get(1);
  let height_buffer = new Int16Array(src_width * src_height);
  // 地形是GDT_Int16 读取所有像素
  const data_type = gdal.GDT_Int16;
  height_band.pixels.read(0, 0, src_width, src_height, height_buffer, {
    buffer_width: src_width,
    buffer_height: src_height,
    data_type: data_type
  });
  // 创建编码转换的栅格文件
  const data_driver = src_ds.driver;
  let encode_ds_path = path.join(os.tmpdir(), uuid() + '.tif');
  let encode_ds = data_driver.create(encode_ds_path, src_width, src_height, 3, data_type);
  encode_ds.srs = src_ds.srs, encode_ds.geoTransform = src_ds.geoTransform;
  let r_buffer = new Uint8Array(src_width * src_height);
  let g_buffer = new Uint8Array(src_width * src_height);
  let b_buffer = new Uint8Array(src_width * src_height);
  // 循环高程，转rgb编码
  if (encoding === 'mapbox') {
    height_buffer.forEach((height, i) => {
      const color = mapboxEncode(height);
      r_buffer[i] = color[0];
      g_buffer[i] = color[1];
      b_buffer[i] = color[2];
    })
  } else if (encoding === 'terrarium') {
    height_buffer.forEach((height, i) => {
      const color = terrariumEncode(height);
      r_buffer[i] = color[0];
      g_buffer[i] = color[1];
      b_buffer[i] = color[2];
    })
  }

  // 写入像素值
  encode_ds.bands.get(1).pixels.write(0, 0, src_width, src_height, r_buffer);
  encode_ds.bands.get(2).pixels.write(0, 0, src_width, src_height, g_buffer);
  encode_ds.bands.get(3).pixels.write(0, 0, src_width, src_height, b_buffer);
  // 刷入磁盘
  encode_ds.flush();
  console.log('地形重编码完成！')
  // step2 影像重投影
  let src_epsg = encode_ds.srs.getAuthorityCode();
  let mkt_ds_path = undefined, dataset;
  // 如果不是墨卡托投影，需要预先投影
  if (src_epsg !== 3857) {
    mkt_ds_path = path.join(os.tmpdir(), uuid() + '.tif');
    //mkt_ds_path = './data/bbb.tif';
    // 地形编码，非普通影像，采用最近邻采样重投影，避免出现尖尖问题
    reprojectImage(encode_ds, mkt_ds_path, 3857, 6);
    dataset = gdal.open(mkt_ds_path, 'r');
  } else
    dataset = encode_ds;
  // 如果不是3857，encode_ds会重投影，到此该数据集已经失去作用了，直接关闭！
  if (src_epsg !== 3857)
    encode_ds.close(mkt_ds_path);
  console.log('地形重投影完成！');

  // stpe3 影像金字塔暂时跳过


  // step4 切片
  const ominx = dataset.geoTransform[0];
  const omaxx = dataset.geoTransform[0] + dataset.rasterSize.x * dataset.geoTransform[1];
  const omaxy = dataset.geoTransform[3];
  const ominy = dataset.geoTransform[3] + dataset.rasterSize.y * dataset.geoTransform[5];


  let mercator = new GlobalMercator();
  // 计算切片总数信息
  let tileCount = 0;
  let levelInfo = {};
  for (let tz = minZoom; tz <= maxZoom; tz++) {
    let { tx: tminx, ty: tminy } = mercator.MetersToTile(ominx, ominy, tz);
    let { tx: tmaxx, ty: tmaxy } = mercator.MetersToTile(omaxx, omaxy, tz);
    tminx = Math.max(0, tminx);
    tminy = Math.max(0, tminy);
    tmaxx = Math.min(Math.pow(2, tz) - 1, tmaxx);
    tmaxy = Math.min(Math.pow(2, tz) - 1, tmaxy);
    tileCount += (tmaxy - tminy + 1) * (tmaxx - tminx + 1);
    levelInfo[tz] = { tminx, tminy, tmaxx, tmaxy };
  }
  // 初始化一个进度条信息
  let progressBar = new ProgressBar(tileCount, 80, '生成地形切片进度');
  let completeCount = 0;

  // 实际裙边有1像素 256+1+1  上下左右各1像素
  // 裙边所需的缩放
  let offset = 0, outTileSize = tileSize;
  if (encoding === 'mapbox') {
    offset = 256.0 / tileSize;
    outTileSize = tileSize + 2;
  }


  let childPids = new Set();
  for (let tz = minZoom; tz <= maxZoom; tz++) {
    const { tminx, tminy, tmaxx, tmaxy } = levelInfo[tz];
    for (let i = tminy; i <= tmaxy; i++) {
      for (let j = tminx; j <= tmaxx; j++) {
        // mapbox地形只认 xyz，不认tms，不用
        let ytile = Math.pow(2, tz) - 1 - i;
        // 由于裙边让周围多了1像素，由于切片是把xyz的地理范围数据编码到512上，所以256这里就是1，512这里就是0.5
        const tileBound = mercator.TileBounds(j, i, tz, offset);
        const { rb, wb } = geo_query(dataset, tileBound.minx, tileBound.maxy, tileBound.maxx, tileBound.miny, outTileSize);
        const createInfo = { outTileSize, rb, wb, dsPath: mkt_ds_path, x: j, y: ytile, z: tz, outputTile };
        workers.createTile(createInfo, function (err, pid) {
          if (err) {
            console.log(err);
          }
          childPids.add(pid);
          completeCount++;
          progressBar.render(completeCount);
          if (completeCount === tileCount) {
            console.timeEnd('地形切片生成');
            // 关闭所有的数据源
            dataset.close();
            //循环关闭子进程的ds，否则临时文件被占用删除不了
            // 由于workfarm是子进程通信，只能传输字符串不能传输对象，且未提供所有子进程关闭的回调函数
            // 采用密集调用分发到子进程，由其自己关闭dataset，实现不是很好，合理设计应更改workfarm源码
            let _count = childPids.size * 4;
            let ending = false;
            for (let i = 0; i < _count; i++) {
              if (ending == true)
                break;
              workers.closeDataset(function (err1, closePid) {
                if (closePid == null)
                  return;
                childPids.delete(closePid);
                if (childPids.size === 0 && ending === false) {
                  ending = true;
                  // 关闭子进程任务
                  workerFarm.end(workers);
                  // 删除临时文件
                  fs.unlinkSync(encode_ds_path);
                  if (mkt_ds_path !== undefined)
                    fs.unlinkSync(mkt_ds_path);
                }
              });
            }
          }
        })
      }
    }
  }
}

function geo_query(ds, ulx, uly, lrx, lry, querysize = 0) {
  const geotran = ds.geoTransform;
  let rx = Math.floor((ulx - geotran[0]) / geotran[1] + 0.001);
  let ry = Math.floor((uly - geotran[3]) / geotran[5] + 0.001);
  let rxsize = Math.max(1, Math.floor((lrx - ulx) / geotran[1] + 0.5));
  let rysize = Math.max(1, Math.floor((lry - uly) / geotran[5] + 0.5));
  let wxsize, wysize;
  if (!querysize) {
    wxsize = rxsize;
    wysize = rysize;
  } else {
    wxsize = querysize;
    wysize = querysize;
  }
  let wx = 0;
  if (rx < 0) {
    let rxshift = Math.abs(rx);
    wx = Math.floor(wxsize * (rxshift * 1.0 / rxsize));
    wxsize = wxsize - wx;
    rxsize = rxsize - Math.floor(rxsize * (rxshift * 1.0 / rxsize));
    rx = 0;
  }
  if ((rx + rxsize) > ds.rasterSize.x) {
    wxsize = Math.floor(wxsize * (ds.rasterSize.x - rx) * 1.0 / rxsize);
    rxsize = ds.rasterSize.x - rx;
  }
  let wy = 0;
  if (ry < 0) {
    const ryshift = Math.abs(ry);
    wy = Math.floor(wysize * (ryshift * 1.0 / rysize));
    wysize = wysize - wy;
    rysize = rysize - Math.floor(rysize * (ryshift * 1.0 / rysize));
    ry = 0;
  }
  if ((ry + rysize) > ds.rasterSize.y) {
    wysize = Math.floor(wysize * (ds.rasterSize.y - ry) * 1.0 / rysize);
    rysize = ds.rasterSize.y - ry;
  }
  return {
    rb: { rx, ry, rxsize, rysize },
    wb: { wx, wy, wxsize, wysize }
  }
}
module.exports = main;