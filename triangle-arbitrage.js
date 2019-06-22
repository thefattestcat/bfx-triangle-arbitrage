'use strict'

//process.env.DEBUG = '*'

const debug = require('debug')('triangle-arbitrage')
const rv2 = require('bitfinex-api-node/examples/rest2/symbols')
const BFX = require('bitfinex-api-node')
const {OrderBook} = require('bfx-api-node-models')
const WSv2 = require('bitfinex-api-node/lib/transports/ws2')
const path = require('path');
const CRC = require('crc-32')

const log = require ('ololog').noLocate;
const ansi = require ('ansicolor').nice;
const style = require ('ansi-styles');
const chalk = require ('chalk');
const TimSort = require('timsort');
const { EventEmitter } = require('events') //Internal Events

const API_KEY = 'jZ1hZvn5dDn1rP4PrEDmY7V5ZwJ5xzzqXXgCvict0Py'
const API_SECRET = 'IJplAkD56ljxUPOs4lJbed0XfmhFaqzIrRsYeV5CvpP'
var fs = require('fs');

//Pair Arrays
//Need to use public API to update pairs automatically, filter out symbols that dont have multiple pairs to arb on.

var tpairs = []   // "tETHBTC"
var symbolOB = [] // {bids:[], asks:[], midprice:[], lastmidprice:[]}
var arbTrades = {} // {p1:[], p2:[], p3:[], minAmount:[]}
var balances = []
var triArray = []
var wsArray = []
var sockets = []
var orderArr = []; 
var alts = [];
var mainpair = 'tETHBTC'
var symbols_details = [];
var stream; //fs streams

const eventEmitter = new EventEmitter(); //Internal Events i.e arbCalc emit arbOpp

const bfx = new BFX ({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  manageOrderBooks: true, // tell the ws client to maintain full sorted OBs
  transform: true // auto-transform array OBs to OrderBook objects
})

const ws = bfx.ws(2,{
  manageOrderBooks: true, // tell the ws client to maintain full sorted OBs
  transform: true // auto-transform array OBs to OrderBook objects
}) 

if(!fs.existsSync(path.join(__dirname,"/log/arbOpp_data.txt"))) {
  stream = fs.createWriteStream(path.join(__dirname,"/log/arbOpp_data.txt"));
} else {
  stream = fs.createWriteStream(path.join(__dirname,"/log/arbOpp_data.txt"), {flags: 'a'}); //Add date to filename?
}

/** 
 * 
 *  Event emitters
 * 
 *  ws - bitfinex-api-node ws2 manager.
 *  eventEmitter - internal event manager for triangle-arbitrage.
 * 
 *  Will try to develop more along this event driven approach.
 *  TODO: Write documentation on internal eventEmitter.
 * 
 **/

/* ws listeners - bfx-api-node */

// Add min/max order size check from https://api.bitfinex.com/v1/symbols_details (array)

ws.on('error', (err) => {
  console.log('error: %s', err)
})

ws.onMessage('', (msg) => {
  //msg = chalk.yellow(msg)
  //console.log(msg)
})

ws.on('open', () => {
  console.log('open')
  ws.auth() 
})

ws.once('auth', async () => {
  console.time('ws.once - auth');  
  console.log('authenticated');
  getBal().then(subscribeOBs()).then(getOBLoop());
  console.timeEnd('ws.once - auth');
})

ws.onWalletSnapshot('', (bal) => { 

  var amount_currencies = bal.length;
  console.log(`-- Balances Snapshot ${Date.now()}--`)
  console.log(`${amount_currencies} currencies`)
  
  for(var i = 0; i<amount_currencies; i++) { 
    balances[i] = bal[i]; 
    console.log( bal[i]['currency'].green, bal[i]['type'], chalk.yellow(bal[i]['balance']));
  }
  
  getBal();

}) 

ws.onWalletUpdate('', (bal) => { 
  
  var amount_currencies = bal.length;
  console.log(`-- Balances Update ${Date.now()}--`)
  console.log(`${amount_currencies} currencies`)
  
  for(var i = 0; i<amount_currencies; i++) { 
    balances[i] = bal[i]; 
    console.log( bal[i]['currency'].green, bal[i]['type'], chalk.yellow(bal[i]['balance']));
  }
  
  getBal();

})

/* eventEmitter listeners - internal */

eventEmitter.on('closed', function(symbol,opptime) {
  let alt = symbol.substring(0,4);
  arbTrades[alt]['stime'] = '';
  console.log(chalk.yellow(`${symbol} Opportunity closed. Lasted ${opptime/1000} seconds`));
})

eventEmitter.on('ArbOpp', (symbol) => {
  let alt = symbol.substring(0,4),
      eth = alt + 'eth',
      btc = alt + 'btc',
      GID = symbol.concat("OGID");

  let TYPE = "LIMIT", 
      AMOUNT = arbTrades[alt].minAmount, //Amount in alt currency
      ETHAMOUNT = arbTrades[alt].minAmount * arbTrades[alt].p3; //Amount in "ETH" or mainpair currency
  
  let ASKAMOUNT, BUYAMOUNT;
      AMOUNT > 0 ? ASKAMOUNT = (-1)*(AMOUNT) : BUYAMOUNT = AMOUNT;
      AMOUNT < 0 ? ASKAMOUNT = AMOUNT : BUYAMOUNT = (-1)*(AMOUNT);

  /**---------------------------**/  
  /**-- BACK TEST THIS FIRST! --**/
  /**---------------------------**/
  //Still need to add logging. to file maybe?  
  //Initialize orderArr, 3 orders
  //make sure ask amounts are negative
  orderArr[alt][0] = { "gid": GID, "type": TYPE, "symbol": eth, "amount": ASKAMOUNT, "price": arbTrades[alt].p1 };
  orderArr[alt][1] = { "gid": GID, "type": TYPE, "symbol": btc, "amount": BUYAMOUNT, "price": arbTrades[alt].p2 };
  orderArr[alt][2] = { "gid": GID, "type": TYPE, "symbol": eth, "amount": ETHAMOUNT, "price": arbTrades[alt].p3 };

  let ordersSent = new Promise ((resolve, reject) => {
    try {   
      for(let i = 0; i <= orderArr.length; i++) {
        //ws.submitOrder(orderArr[alt][i]);
        console.log(`${alt} -- Submitted order ${i+1}: ${orderArr[alt][i].symbol} ${orderArr[alt][i].type} ${orderArr[alt][i].price} ${orderArr[alt][i].amount} `, new Date())
      } 
      resolve();
    } catch(err) { reject(err) }
  })

  ordersSent ? console.log(`${alt} Orders sent successfully `, new Date()) : console.log(`${alt} Orders failed to send `, new Date())
  return ordersSent;
})

/* FUNCTIONS */

async function getBal () {
  console.log(balances)
  module.exports.balances = balances;
  return balances;
}

function getOBLoop () {
console.time("getOBLoop - forEach")
  tpairs.forEach( async (symbol) => { 

    getOBs(symbol);

  })
console.timeEnd("getOBLoop - forEach")
}

function subscribeOBs () {
  
  let counter = 0
  tpairs = rv2.ethbtcpairs
  
  return new Promise ( (resolve, reject) => {
    
    console.time("subscribeOBs - tpairs.forEach");
    tpairs.forEach ( (pair) => {

      let pre = pair.substring(0,4); //prestring e.g "tOMG"
      let suf = pair.substring(4); // suffix e.g "ETH"

      ws.send({ event: 'conf', flags: 131072 }) // Checksum flag
      ws.subscribeOrderBook(pair) 

      try {

        console.log(`subscribed to ${pair} on socket ${Math.abs(CRC.str(pair))}`);
        
        if(suf == 'ETH' && pair !== mainpair) {

          let btc = pre, eth = pre;
          btc += "BTC";
          eth += "ETH";
          // Group symbolOB into altcoin objects (symbolOB["tOMG"]) with eth & btc pairs nested
          symbolOB[pre] = {};
          symbolOB[pre]['crossrate'] = -1;
          symbolOB[pre]['maxAmount'] = 0;
          symbolOB[pre]['lastCs'] = -1;
          
          arbTrades[pre] = {p1:"", p2:"", minAmount:"", crossrate:""};

          for(var i = 0; i <= 3; i++) { 
            orderArr[pre] = []; 
          }
            
          alts.push(pre);
        } 

        if (pair == mainpair) {
          let pre = mainpair.substring(0,4)
          symbolOB[pre] = {};
          
        }
        counter++
      }
      catch(err) {

        console.error(err);
        return reject(err)

      }
    }); 
  alts.push("tETHBTC");
  console.timeEnd("subscribeOBs - tpairs.forEach");
  console.log(chalk.green("--DONE--"))
  console.log("Subscribed to %d out of %d", counter, tpairs.length)
  module.exports.tpairs = tpairs;
  module.exports.alts = alts;
  return true
  
  })
}

function reSubscribe(symbol, alt) {

  return new Promise((resolve,reject) => {

  symbolOB[alt][symbol]['bids'] = [];
  symbolOB[alt][symbol]['asks'] = [];
  
  let unsubbed = new Promise ((resolve, reject) => {

    ws.unsubscribeOrderBook(symbol) 
      ? resolve(console.log(`Unsubscribed from ${symbol}`)) 
      : reject(console.log(`Failed to unsubscribe from ${symbol}`))

  })

  if (unsubbed) {

    //resubscribe to OrderBook
    let resubbed = ws.subscribeOrderBook(symbol)
    
    resubbed ? resolve(console.log("Resubscribed to", symbol)) 
             : reject(console.log("failed to re-subscribe to", symbol))
    
  
  } else if (!unsubbed) {
    reject(console.log("failed to unsubscribe from", symbol))
  }
})

}

// 'ob' is a full OrderBook instance, with sorted arrays 'bids' & 'asks'  
function getOBs(symbol) {
  
  let alt = symbol.substring(0,4)
  let eth = 'ETH', btc = 'BTC'
  let altID = alt.concat('ID')
  let PRECISION = "P0"
  let resub_trigger = 10;
  let checksumcount = []
  checksumcount[symbol] = 0;
  //Use events
  let arbCalcReady = function() {
    if(symbolOB[alt][alt.concat(eth)] && symbolOB[alt][alt.concat(btc)] && symbolOB['tETH'][mainpair]) { 
    
        if((symbolOB[alt][alt.concat(eth)].asks || symbolOB[alt][alt.concat(btc)].bids) && symbolOB['tETH'][mainpair].asks) {
        
          if (alt !== 'tETH') {
            arbCalc(alt);
          }

        }
      }
    }

  ws.onOrderBook({ symbol:symbol, precision:PRECISION, cbGID: altID}, (ob) => { 
    // check if symbolOB has not initialized OrderBook objects for pairs
    if (ob.bids.length !== 0 && ob.asks.length !== 0) {

      symbolOB[alt][symbol] = ob; //Do I need this?
      eventEmitter.emit('ob', { symbol: symbol, bids: ob.bids, asks: ob.asks });
    
    }
    
    if(ws._orderBooks[symbol].length !== 0) {
      
      if(ws._orderBooks[symbol]["csVerified"]) {

        arbCalcReady()

      } else {

        checksumcount[symbol]++;

        if(checksumcount[symbol] >= resub_trigger) {
          
          //Use reSubscribe function?
          let unsub = ws.unsubscribeOrderBook(symbol);
          console.log(`Unsubscribed from ${symbol}`)
          
          if(unsub) {
            
            ws.subscribeOrderBook(symbol);
            console.log(`Resubscribed to ${symbol}`);  
            checksumcount[symbol] = 0;
          
          }
        
        }
      
      } 
    
    }
    
  }) 

  console.log(chalk.bold("fetching orderbook for" ,symbol))
  
}

//make EventEmitter, use listeners to detect arbOpp -> .on(arbOpp) subscribeTrades -> make orders???

let arbCalc = async function (alt) {

  let mpPre = mainpair.substring(0,4),
      eth =  alt.concat("ETH"), 
      btc =  alt.concat("BTC");

  let ob1 = symbolOB[alt][eth], 
      ob2 = symbolOB[alt][btc], 
      ob3 = symbolOB[mpPre][mainpair];
  
  try{
    
    let pair1ask = ob1.asks[0] //symbolOB.tOMG.tOMGETH.asks[0]
    let pair2bid = ob2.bids[0] //symbolOB.tOMG.tOMGb.bids[0]
    let pair3ask = ob3.asks[0] //Pair constraint

    //console.log('PAIR1ASK:', pair1ask, symbolOB[alt], 'PAIR2BID:', pair2bid, symbolOB[p2])
    
    let profit = 0.0 //percentage of profit required to trigger,  
    let crossrate = ((1/pair1ask[0]) * pair2bid[0]) / pair3ask[0] 
    let perc = 1 - crossrate

    let minAmount = Math.min((pair1ask[2])*-1,(pair2bid[2]))
    let minETHAmount = (pair3ask[2]/pair1ask[0])

    let symbols_string = String(alt) + 'ETH > ' + String(alt) + 'BTC > ' + String(mainpair) + ' | '
    let alt_amount = String(arbTrades[alt]['minAmount']) + ' ' + (minETHAmount).toFixed(3)
    let bidask_string = String(pair1ask[0]) + ' ' + String(pair2bid[0]) + ' ' + chalk.bold(String(pair3ask[0]))
    let crossrate_string = crossrate.toFixed(8).toString()
    
    let makerFee = 0.1;
    let takerFee = 0.2;
    
    if (minETHAmount*-1 < minAmount*1) minAmount = minETHAmount; // ask amounts are negative  
    else minAmount = minAmount;
      
    let nowms = Date.now();
    let timer, endtimer; //console timers
    let begindate, enddate; //Date.now() timestamps

    if (crossrate >= (1 + profit)) {
      
      console.log(`${symbols_string.green} ${chalk.bold(alt_amount)} ( ${pair3ask[2]*-1} ETH ) -> ${bidask_string} ${chalk.magenta('crossrate:')} ${chalk.yellow.bold(crossrate_string)}`,new Date())
      eventEmitter.emit('ArbOpp', alt)  
      
      if(crossrate !== arbTrades[alt].crossrate) {
        
        if(typeof timer == 'undefined') {
          
          //Start opportunity Timer
          timer = console.time(alt);
        
        } else {
          
          console.timeLog(alt);
        }

        if(typeof begindate == 'undefined') { 
          
          begindate = Date.now(); //Opportunity open time
          arbTrades[alt]['stime'] = begindate;
        
        }

      }
    
    }
    else {

      if(typeof timer !== 'undefined'){ 
        
        endtimerr = console.timeEnd(alt); 
        console.log(`${alt} lasted ${endtimer}`)
      
      }

      if(crossrate !== arbTrades[alt].crossrate) 
       console.log(`${symbols_string.green} ${chalk.bold(alt_amount)} ( ${pair3ask[2]*-1} ETH ) -> ${bidask_string} ${chalk.magenta('crossrate:')} ${chalk.red.bold(crossrate_string)}`,new Date())
            
      //Check if opp has closed
      if(arbTrades[alt].crossrate >= 1) {
        if(crossrate < arbTrades[alt].crossrate) {
          
          enddate = Date.now();
          let opptime = Math.abs(enddate - arbTrades[alt]['stime']);
          eventEmitter.emit('closed', alt, opptime);
          stream.write(`[${Date.now()}] ${alt} Profit: ${(arbTrades[alt].crossrate-1)*100}% Amount: ${arbTrades[alt].minAmount} p1: [${arbTrades[alt].p1}] p2: [${arbTrades[alt].p2}] p3: [${arbTrades[alt].p3}] - Open for ${(opptime/1000)} secs (${opptime}ms)\n`)
        
        }
      }
    }

    // arbTrade array {}
    arbTrades[alt]['p1'] = pair1ask; 
    arbTrades[alt]['p2'] = pair2bid;
    arbTrades[alt]['p3'] = pair3ask; //make independent entry, make its own function to keep track of mainpair
    arbTrades[alt]['minAmount'] = minAmount;
    arbTrades[alt]['crossrate'] = crossrate;
  }
  catch(err) {
    let errmsg = err.message 
    //symbolOB[alt]['asks'] == undefined ? errarr = alt : errarr = p2
    console.error(alt, err)
  }
}

console.log("Finished!".green)//Finished symbolOB loop

ws.open()

// Organize these?
module.exports.symbolOB = symbolOB;
module.exports.arbTrades = arbTrades; 
module.exports.triArray = triArray;
module.exports.emitter = eventEmitter;