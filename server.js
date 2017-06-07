/*
Copyright 2017 Chiguireitor

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
'use strict'
const named = require('node-named')
const server = named.createServer()
const getJSON = require('get-json')
const util = require('util')
const jayson = require('jayson/promise')
const levelup = require('levelup')
const async = require('async')

const DNS_PORT = 9901
const DNS_IP = '::1'
const ttl = 600 // Don't query me faster than the underlying blockchain
const FIRST_BLOCK_WITH_DNS = 1121984

const config = {
  'xcp': {
    'endpoint': 'https://rpc:1234@public.coindaddy.io:14001/api/'
  }
}

const XCP_API_ENDPOINT = 'https://testnet.counterpartychain.io/api/issuances/'

var db = levelup('./cpdns', {
  valueEncoding: 'json'
})

var xcpClient = jayson.client.https(config.xcp.endpoint)
function xcp(method, params) {
  return xcpClient.request(method, params)
    .then(ob => {
      ob.request = {
        method,
        params
      }

      return ob
    })
}

function getLastBlock() {
  return new Promise((resolve, reject) => {
    db.get('_lastblock', (err, data) => {
      if (err) {
        resolve(FIRST_BLOCK_WITH_DNS - 1)
      } else {
        resolve(parseInt(data))
      }
    })
  })
}

function updateLastBlock(idx) {
  return new Promise((resolve, reject) => {
    db.put('_lastblock', idx, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve(idx)
      }
    })
  })
}

function modifyEntries(res) {
  function entryFunc(entry) {
    return new Promise((resolve, reject) => {
      // get el entry anterior, si no hay crearlo, modificarlo, guardarlo
      //console.log(util.inspect(entry, {colors: true}))
      let asset = entry.asset
      let assetData = entry.description

      db.get(asset, (err, data) => {
        let ob
        if (err) {
          if (err.notFound) {
            ob = {}
          } else {
            reject(err)
          }
        } else {
          ob = data
        }

        let issuanceData = procIssuanceData(assetData, asset)
        if (issuanceData) {
          let typeHash = ob[issuanceData.recordType] || {}
          let keyArray = typeHash[issuanceData.key] || []
          keyArray.push({
            weight: issuanceData.weight,
            value: issuanceData.value
          })
          typeHash[issuanceData.key] = keyArray
          ob[issuanceData.recordType] = typeHash

          //console.log(util.inspect(issuanceData, {colors: true, depth: 3}))
          console.log(util.inspect(ob, {colors: true, depth: 3}))

          db.put(asset, ob, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve(ob)
            }
          })
        } else {
          resolve()
        }
      })
    })
  }

  return Promise.all(res.map(entryFunc))
}

function procIssuanceData(data, postdomain) {
  if (data.length > 0) {
    let op = data[0]
    if (op == '+') {
      let vals = data.slice(1).split(',')

      if (vals.length >= 3) {
        let [idx, weight] = vals[0].split('/')
        let recordType = vals[1]
        let key, value

        //let recordArr = ensureRecord(recordType, idx)

        if (recordType == 'A') {
          if (vals.length == 3) {
            key = postdomain
            value = vals[2]
          } else {
            key = vals[2] + '.' + postdomain
            value = vals[3]
          }
        } else if (recordType == 'CNAME') {
          key = vals[2] + '.' + postdomain
          value = vals[3]
        } else {
          key = vals[2]
          value = vals[3]
        }

        return {
          key,
          recordType,
          value,
          weight
        }
      }
    }
  }
}

function getIssuances(asset) {
  return new Promise((resolve, reject) => {
    let page = 0
    let total = 1
    let issuances = []

    function procPage(err, data) {
      if (err) {
        reject(err)
        return
      }

      if (total > issuances.length) {
        if (data) {
          issuances = issuances.concat(data.data)
        }
        page += 1
        getJSON(XCP_API_ENDPOINT + asset + `/${page}`, procPage)
      } else {
        resolve(issuances)
      }
    }

    procPage()
  })
}

function getParentAsset(domain) {
  return new Promise((resolve, reject) => {
    let tree = domain.split('.')
    let postdomain = tree.slice(1).join('.')

    if (tree.length == 2) {
      // TODO fix this for subassets
      return getIssuances(tree.pop())
        .then((issuances) => {
          let records = {}

          function ensureRecord(tp, idx) {
            if (!(tp in records)) {
              records[tp] = {}
            }

            if (!(idx in records[tp])) {
              records[tp][idx] = []
            }

            return records[tp][idx]
          }

          issuances.forEach((iss) => {
            if (iss.description.length > 0) {
              let op = iss.description[0]
              if (op == '+') {
                let vals = iss.description.slice(1).split(',')

                if (vals.length >= 3) {
                  let [idx, weight] = vals[0].split('/')
                  let recordType = vals[1]
                  let key, value

                  let recordArr = ensureRecord(recordType, idx)

                  if (recordType == 'A') {
                    if (vals.length == 3) {
                      key = postdomain
                      value = vals[2]
                    } else {
                      key = vals[2] + '.' + postdomain
                      value = vals[3]
                    }
                  } else if (recordType == 'CNAME') {
                    key = vals[2] + '.' + postdomain
                    value = vals[3]
                  } else {
                    key = vals[2]
                    value = vals[3]
                  }

                  recordArr.push({
                    key,
                    value,
                    weight
                  })
                }
              }
            }
          })

          resolve([domain, records])
        })
    } else {
      return [domain, []]
    }
  })
}

server.listen(DNS_PORT, DNS_IP, function() {
  console.log(`DNS server started on port ${DNS_IP}:${DNS_PORT}`)
})

const recordTypeCreators = {
  'A': (query, rec) => {
    let res = new named.ARecord(rec.value)
    query.addAnswer(rec.key, res, ttl)
  },
  'CNAME': (query, rec) => {
    let res = new named.CNAMERecord(rec.value)
    query.addAnswer(rec.key, res, ttl)
  }
}

server.on('query', function(query) {
  let isAny = query.type() === 'ANY'
  getParentAsset(query.name())
    .then(([domain, records]) => {
      for (let recordType in records) {
        if (isAny || (query.type() === recordType)) {
          let recs = records[recordType]
          for (let idx in recs) {
            let recArr = recs[idx]

            recArr.forEach((rec) => {
              recordTypeCreators[recordType](query, rec)
            })
          }
        }
      }

      server.send(query)
    })
    .catch((err) => {
      throw err
    })

})

function getNextBlock() {
  return Promise.all([getLastBlock(), xcp('get_running_info')])
    .then(([block, runningInfo]) => {
      //console.log(util.inspect(runningInfo.result, {colors: true}))

      if (!runningInfo.result.db_caught_up) {
        // wait a bit, counterparty is catching up
        throw new Error('XCP DB Catching up')
      } else if (block < runningInfo.result.bitcoin_block_count) {
        let nblock = block + 1
        console.log(`Getting block ${nblock}`)
        return xcp('get_messages', {
            block_index: nblock
          })
      }
    })
    .then(({result, error, request}) => {
      if (error) {
        console.log(error)
      } else if (result) {
        let res = result
          .map(x => (x.category === "issuances")?JSON.parse(x.bindings):null)
          .reduce((arr, elm) => {
            if (elm) {
              arr.push(elm)
            }

            return arr
          }, [])
        //console.log(util.inspect(res, {colors: true}))

        return Promise.all([
          updateLastBlock(request.params.block_index),
          modifyEntries(res)
        ])
      }
    }).then(() => {
      setImmediate(getNextBlock)
    }).catch(err => {
      console.log(util.inspect(err))
    })
}

getNextBlock()
