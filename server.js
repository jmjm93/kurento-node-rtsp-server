var path = require('path');
var express = require('express');
var ws = require('ws');
var kurento = require('kurento-client');
var net = require('net');
var https = require('https');


var app = express();

/*
 * Definition of global variables.
 */
var kurentoClient = null;
const HOSTNAME = 'localhost';
const WS_PORT = 8080;
const KMS_URI = 'ws://localhost:8888/kurento';
const IRIS_URI = 'irisdev.tk'


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
	/*{
		uri: 'rtsp://localhost:8554/vlc',
		port: 8554,
		addr: 'localhost',
		type: 'rtsp',
		key: 'vlc',
		status: STATUS.CLOSED
	},
	{
		uri: 'rtsp://192.168.50.19:8554',
		port: 8554,
		addr: '192.168.50.19',
		type: 'rtsp',
		key: 'mobile',
		status: STATUS.CLOSED
	}*/
	{
		uri: 'rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mov',
		port: 554,
		addr: 'wowzaec2demo.streamlock.net',
		type: 'rtsp',
		key: 'wowza',
		status: STATUS.CLOSED
	}
	/*{
		uri: 'rtsp://20.50.114.197:6604/TVdXRlJTYXVkYXgzLDMsYXVkYXgzLDEsMSwwLDA=',
		port: 6604,
		addr: '20.50.114.197',
		type: 'rtsp',
		key: 'camtest',
		status: STATUS.CLOSED
	}*/
	
];


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
	source.last_vod_addr = vod_addr;
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
										if (!message.sdpOffer) {
											sock.send(JSON.stringify({
												id: 'viewerResponse',
												response: 'rejected',
												error: 'missing fields'
											}));
										}
										startViewer(source, sock, message.sdpOffer, function (error, sdpAnswer, webRtcEndpoint) {
											if (error) {
												return sock.send(JSON.stringify({
													id: 'viewerResponse',
													response: 'rejected',
													message: error
												}));
											}
											if (!clientEndpoints[sock._socket.remoteAddress]) clientEndpoints[sock._socket.remoteAddress] = webRtcEndpoint;
											log('CLIENT ' + sock._socket.remoteAddress + ' CONSUMING STREAM ' + source.key);
											sock.send(JSON.stringify({
												id: 'viewerResponse',
												response: 'accepted',
												sdpAnswer: sdpAnswer
											}));
										});
										break;
									case 'stop':
									log('CLIENT ' + sock._socket.remoteAddress + ' CLOSING STREAM ' + source.key);
										clientEndpoints[sock._socket.remoteAddress].release();
										delete clientEndpoints[sock._socket.remoteAddress];
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
					source.vod_check_interval = setInterval(() => {
						console.log('checking vod size of ' + source.key);
						if(!check_vod_size(source)){
							closeRTSPsource(source);
							listenRTSPsource(source);
						}
					},SOURCE_POLL_PERIOD_MS);
					log('SOURCE ' + source.key + ' STATUS ' + source.status + ' AT ws:\\\\' + HOSTNAME + ':' + WS_PORT + '\\' + key);
					return true;
				});

			});
		})
	})
}

var pollFunc = {};
function listenRTSPsource(source) {
	probe_rtsp_source(source, (ans) => {
		clearInterval(pollFunc[source.addr]);
		if(ans){
			openRTSPsource(source);
		}
		else{
			pollFunc[source.addr] = setInterval(() => {
				listenRTSPsource(source)
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
var probe_rtsp_source = function(source, callback){
		//log('probing ' + source.key);
	const addr_byte = Buffer.from(source.uri, 'utf8').toString('hex');
	var rtsp_options_byte = "4f5054494f4e5320" + addr_byte + "20525453502f312e300d0a";

	var rtsp_desc_byte = "444553435249424520" + addr_byte + "20525453502f312e300d0a"; // RTSP DESCRIBE request field
	// add User-Agent: Gstreamer/1.8.1.1\r\n
	rtsp_desc_byte += "557365722d4167656e743a204753747265616d65722f312e382e312e310d0a";
	rtsp_options_byte += "557365722d4167656e743a204753747265616d65722f312e382e312e310d0a0d0a";
	// add Accept: application/sdp\r\n	
	rtsp_desc_byte += "4163636570743a206170706c69636174696f6e2f7364700d0a0d0a";
	var rtsp_describe_raw_hex = Buffer.from(rtsp_desc_byte, 'hex');
	var rtsp_options_raw_hex = Buffer.from(rtsp_options_byte, 'hex');
	var tcp_probe = new net.Socket();
	var state = 0;
	var sent = false;
	tcp_probe.on('connect', () => {
		tcp_probe.write(rtsp_options_raw_hex);
	});
		
	tcp_probe.on('error', (err) => {
		if(!sent){
			//log(source.key + ' notok');
			callback(false);
			sent = true;
		}
		tcp_probe.destroy();
	});
	tcp_probe.on('data', (ans) => {
		var ans_str = ans.toString();
		var rtsp_code = ans_str.split('\n')[0].split(' ')[1];
		if(rtsp_code[0] === "4" || rtsp_code[0] === "5"){
			tcp_probe.destroy();
			if(!sent){
				//log(source.key + ' notok');
				callback(false);
				sent = true;
				return;
			}
		}
		if(!state){
			tcp_probe.write(rtsp_describe_raw_hex);
			state++;
		}
		else{
			state++;
			if(!sent){
				//log(source.key + ' ok');
				callback(true);
				sent = true;
				return;
			}
			tcp_probe.destroy();
		} 
		
	})
	tcp_probe.setTimeout(3000, () => {
		tcp_probe.destroy();
		callback(false);
	})
	tcp_probe.connect(source.port,source.addr);
	var time = setTimeout(() => {
		tcp_probe.destroy();
		if(!sent){
			//log(source.key + ' timeout');
			callback(false);
			sent = true;
			return;
		}
		clearTimeout(time);
	},3000);
}


// checks if there's a file being actually recorded, in case the file is empty the connection might be broken so it attempts to reconnect
var check_vod_size = function(source){
	if(!source.last_vod_addr) return 0;
	var stats = fs.statSync(source.last_vod_addr.substr(7,100));
	var bytes = stats.size;
	console.log(bytes);
	return bytes;
}


var log = function(message){
	console.log('[' + new Date().toISOString().substring(0,19) + '] ' + message);
}

var log = function(message){
	console.log('[' + new Date().toISOString().substring(0,19) + '] ' + message);
}





app.use(express.static(path.join(__dirname, 'static')));


/*
 * Server startup
 */

var server = app.listen(WS_PORT, function() {
});


//var credentials = {key: privateKey, cert: certificate};

//var httpsServer = https.createServer(credentials, app);
init_sources();

//on exit handler
/*
process.stdin.resume();//so the program will not close instantly
function exitHandler(options, exitCode) {
	log('CLOSING ALL STREAMS ON EXIT SIGNAL');
	rtsp_sources.forEach(source => {
		closeRTSPsource(source);
	})
}

//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit:true}));*/