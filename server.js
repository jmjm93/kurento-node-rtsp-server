var path = require('path');
var express = require('express');
var ws = require('ws');
var kurento = require('kurento-client');
var net = require('net');



var app = express();

/*
 * Definition of global variables.
 */
var kurentoClient = null;
const HOSTNAME = 'localhost';
const TEST_PORT = 8080;
const KMS_URI = 'ws://localhost:8888/kurento';

const STATUS = {
	FAILURE: 'FAILURE',
	CLOSED: 'CLOSED',
	STREAMING: 'STREAMING',
	LISTENING: 'LISTENING'
}

const SOURCE_POLL_PERIOD_MS = 10000;
const MIN_OUTPUT_BANDWIDTH = 1500;
const MAX_OUTPUT_BANDWIDTH = 3000;

const VOD_STORAGE = 'file:///home/jmjm/Videos/kurentotests/';
const VOD_PROFILE = 'MP4_VIDEO_ONLY';

var rtsp_sources = [
	{
		uri: 'rtsp://localhost:8554/vlc',
		port: 8554,
		addr: 'localhost',
		type: 'rtsp',
		key: 'vlc',
		status: STATUS.CLOSED
	},
	{
		uri: 'rtsp://192.168.50.19:5554',
		port: 5554,
		addr: '192.168.50.19',
		type: 'rtsp',
		key: 'mobile',
		status: STATUS.CLOSED
	}
];


/*
 * Server startup
 */

var server = app.listen(TEST_PORT, function() {
});


/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(KMS_URI, function(error, _kurentoClient) {
        if (error) {
            log("KMS NOT FOUND AT " + KMS_URI);
            return false;
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function init_sources(){
	log('INITIALIZING SOURCE LIST, ' + rtsp_sources.length + ' ITEMS');
	rtsp_sources.forEach(source => {
		listenRTSPsource(source);
	});
}


function openRTSPsource(source){
	log('OPENING SOURCE ' + source.key + ' (' + source.uri + ')');
	var rtsp_uri = source.uri;
	var key = source.key;
	var vod_addr = VOD_STORAGE + key + '/' + key.substring(0,12) + '-' + new Date().toISOString().substring(0,16); // ex: [...]/key-2021-12-5T15:14.mp4
	return getKurentoClient(function(error, client) {
		if (error) {
			log('ERROR: ' + error);
			source.status = STATUS.FAILURE;
			return;
		}

		client.create('MediaPipeline', function(error, pipeline) {
			if (error) {
				log('ERROR: ' + error);;
				source.status = STATUS.FAILURE;
				return ;
			}

			pipeline.create('PlayerEndpoint', {networkCache: 0, uri : rtsp_uri}, function(error, player) {
				if (error) {
					log('ERROR: ' + error);;
					source.status = STATUS.FAILURE;
					return;
				}
				pipeline.create('RecorderEndpoint', {uri: vod_addr, mediaProfile:VOD_PROFILE}, function(error, recorder) {
					if (error) {
						log('ERROR: ' + error);;
						source.status = STATUS.FAILURE;
						return;
					}

					recorder.on('Error', function (a) { 
						log('ERROR: ' + error);;
						source.status = STATUS.FAILURE;
						return;
					});

					player.on('EndOfStream', function (a) {
						log('STREAM ' + source.key + ' ENDED AT SOURCE');
						closeRTSPsource(source);
						listenRTSPsource(source);
						return;
					})
					player.connect(recorder);
					recorder.record(error => { if(error) log('ERROR: ' + error); });
					
					player.play((err) => {
						if(err) log('ERROR: ' + err);
					});

					if(!source.socket){
						var _sock = new ws.Server({
							server : server,
							path : '/' + key
						});

						_sock.on('connection', function(sock) {
							var clientEndpoints = {};
							sock.on('message', function(_message) {
								var message = JSON.parse(_message);
								switch (message.id) {
									case 'sdp_offer':
										startViewer(source, sock, message.sdpOffer, function(error, sdpAnswer, webRtcEndpoint) {
											if (error) {
												return sock.send(JSON.stringify({
													id : 'viewerResponse',
													response : 'rejected',
													message : error
												}));
											}

											if(!clientEndpoints[sock._socket.remoteAddress]) clientEndpoints[sock._socket.remoteAddress] = webRtcEndpoint;
											log('CLIENT ' + sock._socket.remoteAddress + ' CONSUMING STREAM ' + source.key);
											sock.send(JSON.stringify({
												id : 'viewerResponse',
												response : 'accepted',
												sdpAnswer : sdpAnswer
											}));
										});
										break;
									case 'stop':
									log('CLIENT ' + sock._socket.remoteAddress + ' CLOSING STREAM ' + source.key);
										clientEndpoints[sock._socket.remoteAddress].release();
										delete clientEndpoints[sock._socket.remoteAddress]
										break;
								}
								
							});
						})
						source.socket = _sock;
					}
					source.pipeline = pipeline;
					source.recorder = recorder;
					source.player = player;
					source.status = STATUS.STREAMING;
					log('SOURCE ' + source.key + ' STATUS ' + source.status + ' AT ws:\\\\' + HOSTNAME + ':' + source.port + '\\' + key);
					return true;
				});

			});
		})
	})
}

var pollFunc = {};
function listenRTSPsource(source) {
	probe_rtsp_source(source.addr, source.port, source.key, (ans) => {
		if(ans){
			openRTSPsource(source);
		}
		else{
			pollFunc[source.addr] = setInterval(() => {
				listenRTSPsource(source)
				clearInterval(pollFunc[source.addr]);
			}, SOURCE_POLL_PERIOD_MS);
			var prevStat = source.status;
			source.status = STATUS.LISTENING;
			if(prevStat !== source.status) log('SOURCE ' + source.key + ' STATUS ' + source.status);
		}
	})
	
}

function closeRTSPsource(source) {
	log('CLOSING SOURCE ' + source.key + ' (' + source.uri + ')');
	if(source.recorder){
		source.recorder.stop(error => {
			if (error) {
				source.status = STATUS.FAILURE;
			}
		});
	}
	if(source.player){
		source.player.pause(error => {
			if (error) {
				source.status = STATUS.FAILURE;
			}
		});
	}
	if(source.pipeline){
		source.pipeline.release();
		source.pipeline = null;
	}
	if(source.status !== STATUS.FAILURE) source.status = STATUS.CLOSED;
	log('SOURCE ' + source.key + ' STATUS ' + source.status);
}

function startViewer(source, ws, sdpOffer, callback) {

	source.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			stop();
			return callback(error);
		}

		
        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });

		webRtcEndpoint.setMinVideoRecvBandwidth(MIN_OUTPUT_BANDWIDTH);
      webRtcEndpoint.setMaxVideoRecvBandwidth(MAX_OUTPUT_BANDWIDTH);
		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				stop();
				return callback(error);
			}
			source.player.connect(webRtcEndpoint, function(error) {
				if (error) {
					stop();
					return callback(error);
				}
				callback(null, sdpAnswer, webRtcEndpoint);
		        webRtcEndpoint.gatherCandidates(function(error) {
		            if (error) {
			            stop();
			            return callback(error);
		            }
		        });
		    });
	    });
	});
}

function stop() {
	rtsp_sources.forEach(closeRTSPsource);
}

// opens a tcp connection and sends an RTSP DESCRIBE request to see if the stream is available
var probe_rtsp_source = function(addr, port, key, callback){
	const addr_byte = Buffer.from('rtsp://' + addr + ':' + port + '/' + key, 'utf8').toString('hex');
	var rtsp_desc_byte = "444553435249424520" + addr_byte + "20525453502f312e300d0a0d0a"; // RTSP DESCRIBE request field
	//var rtsp_setup_byte = "534554555020" + addr_byte + "20525453502f312e300d0a0d0a"; // RTSP SETUP request field
	var rtsp_describe_raw_hex = Buffer.from(rtsp_desc_byte, 'hex');
	//var rtsp_setup_raw_hex = Buffer.from(rtsp_setup_byte, 'hex');	
	var tcp_probe = new net.Socket();
	tcp_probe.on('connect', () => 
		tcp_probe.write(rtsp_describe_raw_hex));
		
	tcp_probe.on('error', (err) => {
		callback(false);
		tcp_probe.destroy();
	});
	tcp_probe.on('data', (ans) => {
		var ans_str = ans.toString();
		var rtsp_code = ans_str.split('\n')[0].split(' ')[1];
		callback(rtsp_code === "200");
		tcp_probe.destroy();
		
	})
	tcp_probe.connect(port,addr);
}

var log = function(message){
	console.log('[' + new Date().toISOString().substring(0,19) + '] ' + message);
}

//probe_rtsp_source('127.0.0.1',8554,'vlc', function(ans) {});


app.use(express.static(path.join(__dirname, 'static')));
init_sources();
