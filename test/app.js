const path = require('path');
const fs = require('fs');

const demPath = path.join(__dirname, 'test.tif');
const tileDirPath = path.join(__dirname, 'terrain');

const config = {
    "zoom": "5-13",
    "epsg": 3857,
    "size": 256,
    "resampling": 3,
    "encoding": "mapbox",
    "input": demPath,
    "output": tileDirPath,
    "clean": true
}

fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config));
