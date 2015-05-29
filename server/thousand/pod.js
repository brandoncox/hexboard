'use strict';

var Rx = require('rx')
  , RxNode = require('rx-node')
  , split = require('split')
  , cc = require('config-multipaas')
  , fs = require('fs')
  , thousandEmitter = require('./thousandEmitter')
  , request = require('request')
  ;

var tag = 'POD';

// Config
var config   = cc().add({
  oauth_token: process.env.ACCESS_TOKEN || false,
  namespace: process.env.NAMESPACE || 'demo2',
  openshift_server: process.env.OPENSHIFT_SERVER || 'openshift-master.summit.paas.ninja:8443'
})

// Allow self-signed SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var url = 'https://' + config.get('openshift_server') + '/api/v1beta3/watch/pods'
var options = {
  'method' : 'get'
 ,'uri'    : url
 ,'qs'     : {'namespace': config.get('namespace')}
 ,'rejectUnauthorized': false
 ,'strictSSL': false
 ,'auth'   : {'bearer': config.get('oauth_token') }
}

function podIdToURL(id){
  return "sketch-"+id+"-app-summit3.apps.summit.paas.ninja"
}

function podNumber(name){
  var num = name.match(/[0-9][0-9]*/);
  return num[0];
}
function verifyPodAvailable(pod, retries_remaining){
  //verify that the app is responding to web requests
  //retry up to N times
  console.log("live: " + pod.data.name);
  thousandEmitter.emit('pod-event', pod.data);
}

var parseData = function(update){
  var podName = update.object.spec.containers[0].name;
  if (podName.indexOf('doodle') !== 0) {
    // console.log('Ignoring update for container name:', update.object.spec.containers[0].name);
  } else {
    //bundle the pod data
    update.data = {
      id: podNumber(podName),
      name: podName,
      hostname: podName + '-summit3.apps.summit.paas.ninja',
      stage: update.type,
      type: 'event',
      timestamp: new Date(),
      creationTimestamp: new Date(update.object.metadata.creationTimestamp)
    }
    if(update.type == 'ADDED'){
      update.data.stage = 1;
    }
    else if(update.type == 'MODIFIED'){
      update.data.stage = 2;
    }
    else if(update.type == 'DELETED'){
      update.data.stage = 3;
    }else{
      console.log("New data type found:" + JSON.stringify(update))
    }
  }
  return update;
}



  // stream.pipe(fs.createWriteStream('./server/thousand/pods-create-raw.log'))
  // var writeStream = fs.createWriteStream('./server/thousand/pods-create-parsed.log');

var lastResourceVersion;
var connect = Rx.Observable.create(function(observer) {
  console.log('options', options);
  var stream = request(options);
  var lines = stream.pipe(split());
  stream.on('response', function(response) {
    if (response.statusCode === 200) {
      console.log('Connection success');
      observer.onNext(lines)
    } else {
      stream.on('data', function(data) {
        var message;
        try {
          var data = JSON.parse(data);
          message = data.message;
        } catch(e) {
          message = data.toString();
        }
        var error = {
          code: response.statusCode
        , message: message
        };
        console.log(error);
        observer.onError(error);
      });
    }
  });
  stream.on('error', function(error) {
    console.log('error:',error);
    observer.onError(error);
  });
  stream.on('end', function() {
    console.log('request terminated, retrying');
    observer.onError('retry');
  });
})
.retryWhen(function(errors) {
  return errors.scan(0, function(errorCount, err) {
    console.log('Connection error:', err)
    if (err === 'retry') {
      options.qs.resourceVersion = lastResourceVersion; // get only updates
      return true;
    } else {
      throw err;
    }
  });
})
.shareReplay(1);

var liveStream = connect.flatMap(function(stream) {
  return RxNode.fromStream(stream)
})
.map(function(data) {
  try {
    var json = JSON.parse(data);
    lastResourceVersion = json.object.metadata.resourceVersion;
    json.timestamp = new Date();
    return json;
  } catch(e) {
    console.log('JSON parsing error:', e);
    return null;
  }
})
.filter(function(json) {
  return json;
})
.shareReplay(undefined, 200);

var parsedStream = liveStream.map(function(json) {
  return parseData(json);
})
.filter(function(parsed) {
  return parsed && parsed.data && parsed.data.stage && parsed.data.id <= 1025;
})
.map(function(parsed) {
  // console.log(parsed.data);
  return parsed.data;
});

module.exports = {
  rawStream: liveStream
, eventStream: parsedStream
, parseData : parseData
};
