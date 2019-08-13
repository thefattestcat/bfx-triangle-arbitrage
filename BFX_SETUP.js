const BFX = require('bitfinex-api-node')
const WSv2 = require('bitfinex-api-node/lib/transports/ws2')
var api_obj = require('./apikeys.json');

var API_KEY = api_obj.test.api_key;
var API_SECRET = api_obj.test.api_secret;

var bfxArray = [];
const bfx = new BFX ();

// ? BFX instance loop 
async function makeInstances() {
for (var i = 0; i <= 5; i++) {
    bfxArray[i] = bfx.ws(2,{
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      manageOrderBooks: true, // tell the ws client to maintain full sorted OBs
      transform: true // auto-transform array OBs to OrderBook objects
    })  
    console.log("Pushed bfx.ws to bfxArray -> " + bfxArray[i])
    }
}

makeInstances().then(console.log(bfxArray[0]));

module.exports.BFX_INSTANCES = bfxArray;