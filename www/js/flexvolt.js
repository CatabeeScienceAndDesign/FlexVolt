/* Original Author: Brendan Flynn & Rob Chambers!
 *
 * Stand-alone factory to handle all FlexVolt communications
 *
 * Provides methods (such as getData) which can be called regularly to get data
 *
 * ex:
 *      function updateAnimate(){
 *          var data = getData();
 *          do animation stuff with the new data
 *      }
 *
 *      function animateStep(){
 *          afID = window.requestAnimationFrame(paintStep);
 *          updateAnimate();
 *      }
 *
 *      animateStep();
 *
 * The above example calls getData every frame (typically 60 FPS)
 *
 */

(function () {
'use strict';

angular.module('flexvolt.flexvolt', [])

/**
 * Abstracts the flexvolt, deals with bluetooth communications, etc.
 */
.factory('flexvolt', ['$q', '$timeout', '$interval', '$ionicPopup', 'bluetoothPlugin', 'hardwareLogic', 'devices','generalData',
  function($q, $timeout, $interval, $ionicPopup, bluetoothPlugin, hardwareLogic, devices, generalData) {
    // Breaking Changes

    // Firmware version 5 introduces on-board RMS and HP filters.
    // The RMS filter uses the same command interface as the previous smoothing filter
    // The HP filter uses control bits in the former custom frequency command bytes
    var BREAKING_CHANGE_ONBOARD_RMS_VERSION = 5;
    var ONBOARD_RMS_MAX_CHANNELS = 4; // PIC isn't fast enough to run RMS for 8 channels

    // Firmware version 5 introduces ability to trigger bluetooth module reprogram
    // by clearing flash bit the FlexVolt sensor checks on startup.
    var BREAKING_CHANGE_RESET_BLUETOOTH_MODULE = 5;

    // Firmware version 4 introduces ability to poll battery of the sensor
    var BREAKING_CHANGE_POLL_BATTERY = 4;

    var connectionTestInterval;
    var receivedData;
    var waitingForResponse = false;
    var waitingForMessage;
    var waitingForBytes;
    var waitingForFunction;
    var DEFAULT_WAIT_MS = 5000, DEFAULT_CONNECTED_WAIT_MS = 5000, DISCOVER_DELAY_MS = 500;
    var MODEL_LIST = [];
    MODEL_LIST[0] = {
      name: 'USB 2 Channel',
      channels: 2
    };
    MODEL_LIST[1] = {
      name: 'USB 4 Channel',
      channels: 4
    };
    MODEL_LIST[2] = {
      name: 'USB 8 Channel',
      channels: 8
    };
    MODEL_LIST[3] = {
      name: 'Bluetooth 2 Channel',
      channels: 2
    };
    MODEL_LIST[4] = {
      name: 'Bluetooth 4 Channel',
      channels: 4
    };
    MODEL_LIST[5] = {
      name: 'Bluetooth 8 Channel',
      channels: 8
    };
    MODEL_LIST[6] = {
      name: 'BluetoothLE 2 Channel',
      channels: 2
    };
    MODEL_LIST[7] = {
      name: 'BluetoothLE 4 Channel',
      channels: 4
    };
    MODEL_LIST[8] = {
      name: 'BluetoothLE 8 Channel',
      channels: 8
    };
    var FREQUENCY_LIST = [1, 10, 50, 100, 200, 300, 400, 500, 1000, 1500, 2000];
    var RMS_WINDOW_SIZE_LIST = [10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250];

    // Settings Masks
    var HP_FILTER_ON = 128; //              0b10000000;
    var SMOOTH_FILTER_MODE_RMS = 64; //     0b01000000;
    var SMOOTH_FILTER_MODE_SHIFT = 0; //    0b00000000;
    var ENABLE_BATTERY_TEST = 1; //         0b00000001;

    // Settings Update Controls
    var updateSettingsCurrentRegisterIndex = 0;
    var updateSettingsAgainRequested = false;
    var showBLEDataRateWarningFlag = true;

    var dots = '';
    // flag to make sure we don't end up with multipe async read calls at once!
    var checkingForData = false;
    var dIn = [], dataParsed = [];

    var pollingTimeout, pollingInterval;
    var updateSettingsRepeatCount = 0;

    // Time Stamps
    var timestamp;
    var timestampInterval;
    var timingCheckInterval;

    var GAIN = 1845; // Primary gain = 405.  Secondary gain =
    var SupplyVoltageBattery = 4.2;
    var SupplyVoltageUSB = 5.0;
    var VMaxBattery = (1000000*(SupplyVoltageBattery/2)/GAIN).toFixed(2); //1138uV // 1.35
    var VMaxUSB = (1000000*(SupplyVoltageUSB/2)/GAIN).toFixed(2); //1355uV // 1.35
    var FactorBattery8Bit = VMaxBattery/128; // 8.89uV
    var FactorBattery10Bit = VMaxBattery/512; // 2.22uV
    var FactorUSB8Bit = VMaxUSB/128; // 10.58uV
    var FactorUSB10Bit = VMaxUSB/512; // 2.65uV
    var factor8Bit = FactorUSB8Bit; // defaults - USB, since 5 Volt window will show all of both sensor outputs
    var factor10Bit = FactorUSB10Bit; // defaults - USB, since 5 Volt window will show all of both sensor outputs

    //promise bucket
    var deferred = {};

    // api... contains the API that will be exposed via the 'flexvolt' service.
    var api = {
        startConnect: undefined,
        disconnect: undefined,
        updatePorts: undefined,
        turnDataOn: undefined,
        turnDataOff: undefined,
        validateSettings: undefined,
        updateSettings: undefined,
        pollVersion: undefined,
        getDataParsed: undefined,
        flexvoltPortList: [],
        tryList: undefined,
        currentDevice: undefined,
        pollBattery: undefined,
        getIsBatteryLevelAvailable: function(){return false;},
        updateBatteryIndicator: function(newLevel){}, // defined by connection-indicator ctrl
        connection: { // properties dependent on the device connected
            initialWait: undefined,
            connectedWait: undefined,
            version: undefined,
            serialNumber: undefined,
            modelNumber: undefined,
            model: undefined,
            state: undefined,
            data: undefined,
            dataOnRequested: undefined,
            flexvoltName: undefined,
            batteryVoltage: undefined
        },
        versionMinimums: {
            resetBluetoothModule: BREAKING_CHANGE_RESET_BLUETOOTH_MODULE,
            pollBattery: BREAKING_CHANGE_POLL_BATTERY,
            onboardRMS: BREAKING_CHANGE_ONBOARD_RMS_VERSION
        },
        readParams : {
            expectedChar : undefined,
            expectedBytes: undefined,
            offset: undefined
        }
    };

    function simpleLog(msg) { console.log(msg); }

    ionic.Platform.ready(function(){

        function subscribe() {
            bluetoothPlugin.subscribe(
                api.currentDevice,
                function(data){
                    var bytes = new Uint8Array(data);
                    onDataReceived(bytes);
                },
                function(e){
                    console.log('ERROR: error in subscribe: ' + JSON.stringify(e));
                    if (e.error === 'device_lost'){
                        connectionErr('connection lost');
                    }
                }
            );
        }

        function unsubscribe() {
            bluetoothPlugin.unsubscribe(
                api.currentDevice,
                function(){
                    console.log('DEBUG: successful unsubscribe');
                },
                simpleLog
            );
        }

        function init(){
            api.connection.state = 'begin';
            api.connection.data = 'off';
            api.connection.dataOnRequested = false;
            api.connection.initialWait = DEFAULT_WAIT_MS;
            api.connection.connectedWait = DEFAULT_CONNECTED_WAIT_MS;

            // set to default battery mode...
            hardwareLogic.settings.vMax = VMaxBattery;
        }

        api.connection.initialWaitList = [500, 1000, 5000, 10000];
        api.connection.connectedWaitList = [500, 1000, 5000, 10000, 20000];
        api.setInitialWait = function(newWaitMS) {
            if (newWaitMS && typeof(newWaitMS) === 'number') {
                api.connection.initialWait = newWaitMS;
            }
        };
        api.resetInitialWait = function(){
            api.connection.initialWait = DEFAULT_WAIT_MS;
        };
        api.setConnectedWait = function(newWaitMS) {
            if (newWaitMS && typeof(newWaitMS) === 'number') {
                api.connection.connectedWait = newWaitMS;
            }
        };
        api.resetConnectedWait = function(){
            api.connection.connectedWait = DEFAULT_CONNECTED_WAIT_MS;
        };

        function cancelTimeout() {
            if ( pollingTimeout ) {
                $timeout.cancel(pollingTimeout);
                pollingTimeout = undefined;
            }
            if ( pollingInterval ) {
                $interval.cancel(pollingInterval);
                pollingInterval = undefined;
            }
        }

        api.cancelConnection = function() {
          cancelTimeout();
          for (var p in deferred){
            deferred[p].reject('Connection Attempt Cancelled');
            delete deferred[p];
          }
          api.disconnect();
        };

        // Connection Code.
        function connectedCB(){
            console.log('DEBUG: connectedCB');
            turnDataOn();
        }
        function notConnectedCB(){
            console.log('DEBUG: notConnectedCB');
            api.resetConnection();
        }

        // the interval connection check call
        function checkConnection(){
            if (api.connection.state === 'connected' && api.connection.data !== 'on'){
                // it can take a while for the bluetooth service to notice a drop, at least in chrome
                // bluetoothPlugin.isConnected(connected, notConnected);
                // console.log('DEBUG: Connected NOT taking data');
                // if data off, just handshake.  If the handshake fails (connectionErr, expected return chars not received
//                testHandshake(function(){
//                    //console.log('DEBUG: testHandshake worked');
//                });
            } else if(api.connection.state === 'connected' && api.connection.data === 'on') {
                //console.log('DEBUG: Connected and taking data');
                if (receivedData){
                    //connection still good.  reset flag
                    receivedData = false;
                } else {
                    // was data turned off?
                    console.log('ERROR: Stopped getting data.');
                    // check connection, try turning data back on
                    bluetoothPlugin.isConnected(api.currentDevice, connectedCB, notConnectedCB, connectionErr);
                }
            }
        }

        function parseBluetoothModuleDetails(tmp) {
            var returnedFlagJYMCU = tmp[1];
            var testFlagU = tmp[3];
            var tmpTriedToProgramJYMCU = tmp[4];
            var triedToProgramJYMCU;
            if (tmpTriedToProgramJYMCU === 1){
                triedToProgramJYMCU = true;
            } else if (tmpTriedToProgramJYMCU === 2) {
                triedToProgramJYMCU = false;
            }
            var testFlagW = tmp[5];
            var tmpProgrammedJYMCU = tmp[6];
            var programmedJYMCU;
            if (tmpProgrammedJYMCU === 3) {
                programmedJYMCU = true;
            } else if (tmpProgrammedJYMCU === 4) {
                programmedJYMCU = false;
            }
            console.log('DEBUG: JYMCU flag: ' + returnedFlagJYMCU +
                        // ', testFlagU: ' + testFlagU +
                        // ', triedToProgram value: ' + tmpTriedToProgramJYMCU +
                        ', triedToProgram: ' + triedToProgramJYMCU +
                        // ', testFlagW: ' + testFlagW +
                        // ', programmedJYMCU value: ' + tmpProgrammedJYMCU +
                        ', programmedJYMCU: ' + programmedJYMCU);
        }

        // FOR TIMING DEBUGGING
        // var rCount = 0;
        // var itt = $interval(function(){
        //   var t = rCount;
        //   rCount = 0;
        //   console.log('Received ' + t + ' bytes.');
        // },1000)

        // Async event listener function to pass to subscribe/addListener
        function onDataReceived(d){
            receivedData = true;

            for (var key in d) {
                if (d.hasOwnProperty(key)) {
                    dIn.push(d[key]);
                }
            }

            // basically everything but actual data.
            if (api.connection.data === 'off' || api.connection.data === 'turningOn') {
              console.log('DEBUG: State: ' + api.connection.state +
                          '. Input: ' + JSON.stringify(dIn));
            }

            // if waiting for a communications response, look for it
            if (waitingForResponse) {
                checkForMessage();
            }
        }

        function checkForMessage(){
            if (waitingForMessage.length !== undefined && waitingForMessage.length > 0){
                // waiting for an array.  look for first member.
                //console.log('DEBUG: waiting for: ' + waitingForMessage + ', total received: ' + JSON.stringify(dIn));
                var msgLen = waitingForMessage.length + waitingForBytes;
                while (dIn.length > 0 && dIn[0] !== waitingForMessage[0]){
                    dIn.splice(0,1); // throw away non-matching vals
                }

                if (dIn.length > 0 && dIn[0] === waitingForMessage[0]){
                    // found a potential match.  compare the rest of the values
                    // console.log('DEBUG: found start of message');

                    if (dIn.length >= msgLen) {
                        // console.log('DEBUG: got correct length for entire message');
                        var match = true;
                        for (var iM = 0; iM < waitingForMessage.length; iM++){
                            if (dIn[iM] === waitingForMessage[iM]){
                                // still a match
                            } else {
                                // missing something
                                match = false;
                            }
                        }
                        if (match) {
                            console.log('DEBUG: found the expected message in realtime: ' + JSON.stringify(waitingForMessage));
                            cancelTimeout();
                            waitingForResponse = false;
                            if (waitingForMessage[0] === 97) {
                                // initial handshake - get status bits from JYMCU programming if available
                                if (dIn.length >= 7) {
                                    parseBluetoothModuleDetails(dIn);
                                }
                            }
                            // if found the message, run the follow on
                            waitingForFunction();
                            return true;
                        }
                    }
                }
            } else {
                console.log('ERROR: waiting for response, but no message defined!  waitingForMessage: ' + JSON.stringify(waitingForMessage));
            }
            return false;
        }

        var connectionRepeat = 10;
        var connectedRepeat = 5;

        // Send a command, wait for nBytes, check received bytes against inMsg, call nextFunc!
        function waitForInput(outMsg, repeat, repeatN, waitTime, inMsg, expectedBytes, nextFunc){
            console.log('DEBUG: writing ' + outMsg + ', waiting ' + waitTime + ' for ' + inMsg + ' and ' + expectedBytes + ' data bytes.');
            if (outMsg !== null){
                // console.log('OUTPUT: '+outMsg);
                write(outMsg);
                if (repeat) {
                  pollingInterval = $interval(function() {
                    console.log('DEBUG: resending: '+outMsg);
                    write(outMsg);
                },400,repeatN);
                }
            }

            // set global fields for use in onDataReceived and checkForMessage
            waitingForResponse = true;
            // inMsg = {matchArray, additionalBytesExpected}
            if (inMsg.length === undefined || inMsg.length <= 0){
              inMsg = [inMsg];
            }
            waitingForMessage = inMsg;
            if (expectedBytes === undefined) {expectedBytes = 0;}
            waitingForBytes = expectedBytes;
            waitingForFunction = nextFunc;

            // wait for data to come back
            pollingTimeout = $timeout(function(){
                cancelTimeout();
                console.log('DEBUG: timed out waiting for response');
                if (waitingForResponse) {
                    var success = checkForMessage();

                    if (!success){
                        waitingForResponse = false;
                        // if (api.connection.state === 'updating settings'){
                        //   console.log('ERROR - did not get expected message 122 after updating settings.  Giving user option of continuing.');
                        //   var alertPopup = $ionicPopup.alert({
                        //       title: 'Error Updating Settings',
                        //       template: 'Hardware settings may not have been properly updated.  Try out \'RMS\' page, and if you are not getting data, try turning your FlexVolt sensor off, then back on, then reset the connection.  (use the connection icon top right).'
                        //   });
                        //   console.log('WARNING: pretending the proper message was received after updating settings to try to limp along.');
                        //   nextFunc();
                        //   return;
                        // } else {
                          connectionErr('Expected '+inMsg);
                        // }
                    }
                }
            },waitTime);
        }

        function connectionErr(e) {
            console.log('DEBUG: connectionErr: '+JSON.stringify(e));
            $interval.cancel(connectionTestInterval);
            cancelTimeout();
            waitingForResponse = false;
            api.connection.data = 'off';
            api.connection.dataOnRequested = false;
            if (api.connection.state === 'connecting'){
                unsubscribe();
                if (api.tryList && api.tryList.length > 0) {
                  console.log('DEBUG: Testing next port');
                  bluetoothPlugin.disconnect(api.currentDevice, tryPorts, simpleLog);
                } else {
                  console.log('WARNING: No FlexVolts found!');
                  api.connection.state = 'no flexvolts found';
                  //didn't find anything.  Update port list.
                  $timeout(api.updatePorts, DISCOVER_DELAY_MS);
                }
            } else if (api.connection.state === 'connected'){
                console.log('WARNING: Connection lost!  Attempting to reconnect with ' + api.connection.flexvoltName + '.');
                api.connection.state = 'reconnecting';
                // reset connection, then get a list of available devices and try to reconnect to the currentDevice
                connectionResetHandler(function() {
                  api.discoverFlexVolts()
                    .then(function() {
                      var match = api.tryList.filter(function(availableDevice) {
                        return availableDevice.name === api.connection.flexvoltName;
                      });
                      if (match && match.length > 0) {
                        console.log('DEBUG: found the formerly connected device.  Attempting to reconnect');
                        api.currentDevice = match[0];
                        api.connection.state = 'connecting';
                        attemptToConnect(api.currentDevice);
                      } else {
                        console.log('DEBUG: Connection dropped, unable to find previously connected device.');
                        api.connection.state = 'begin';
                      }
                    });
                });
            } else if (api.connection.state === 'updating settings'){
                api.connection.state = 'connected';
                write('Q');
                console.log('WARNING: Did not get expected responses while updating setings.  Trying again.');
                updateSettingsRepeatCount += 1;
                if (updateSettingsRepeatCount <= 3) {
                  api.updateSettings();
                }
            } else {
                console.log('WARNING: Connection dropped!  State: '+api.connection.state);
                connectionResetHandler(api.discoverFlexVolts);
            }
        }
        function connectionResetHandler(cb){
            console.log('DEBUG: connectionResetHandler');
            $interval.cancel(connectionTestInterval);
            api.connection.state = 'disconnected';
            api.connection.data = 'off';
            waitingForResponse = false;
            bluetoothPlugin.unsubscribe(
              api.currentDevice,
              function() {
                  bluetoothPlugin.disconnect(
                      api.currentDevice,
                      function () {
                          api.currentDevice = undefined;
                          if (cb){
                              console.log('DEBUG: Reseting Connection.');
                              $timeout(cb,250);
                          } else {
                              api.connection.state ='begin';
                              bluetoothPlugin.clear(
                                  null,
                                  function() {
                                      console.log('DEBUG: Cleared Connection');
                                  }, function() {
                                      console.log('ERROR: Error clearing bluetooth');
                                  }
                              );

                          }
                      },
                      function (err) { console.log('EERROR: during connectionResetHandler disconnect: ' + JSON.stringify(err));}
                  );
              },
              function(err){console.log('ERROR: during connectionResetHandler unsubscribe: ' + JSON.stringify(err));}
            );
        }
        api.resetConnection = function(){
            // User interface
            console.log('DEBUG: resetConnection, state:'+api.connection.state);
            if (api.connection.state === 'connecting' || api.connection.state === 'searching'){
                console.log('INFO: connection attempt already in progress');
                return;
            }
            $timeout(function(){
                connectionResetHandler(api.startConnect);
            },250);
        };
        api.disconnect = function(){
            write('X');
            console.log('DEBUG: disconnection');
            connectionResetHandler(false);
        };
        api.updatePorts = function() {
            console.log('DEBUG: updating portlist');
            devices.reset();
            bluetoothPlugin.getDevices(devices.add, simpleLog);
        };
        api.discoverFlexVolts = function() {
            deferred.discover = $q.defer();
            console.log('INFO: Listing devices...');
            api.connection.state = 'searching';
            devices.reset();
            bluetoothPlugin.getDevices(devices.add, connectionErr);
            $timeout(function() {
              var tmpPreferred = devices.getPreferred();
              var tmpUnknown = devices.getUnknown();
              api.tryList = tmpPreferred.concat(tmpUnknown);
              if (deferred.discover) {deferred.discover.resolve();}
            }, 1000); // TODO - get rid of this, make it smarter

            return deferred.discover.promise;
        };
        function tryPorts(){
            console.log('DEBUG: in tryPorts');
            api.currentDevice = undefined;


            //console.log(api.tryList);
            // the tryList is a copy of the ports list.  Try each port, then remove it from the list
            // if it's a flexvolt, add that port to flexvoltPortList
            // once the tryList is empty, if we found a flexvolt connect.  Otherwise, error out, go back to begin
            if (api.tryList.length > 0){
                api.currentDevice = api.tryList.shift();
                api.connection.state = 'connecting';
                attemptToConnect(api.currentDevice);
            } else {
                console.log('WARNING: No FlexVolts found!');
                //didn't find anything?!
                api.connection.state = 'no flexvolts found';
            }
        }
        api.manualConnect = function(device){
            console.log('manual connect with device: ' + JSON.stringify(device));
            connectionResetHandler(function(){
                api.connection.state = 'connecting';
                api.currentDevice = device;
                console.log('DEBUG: Manual connect ' + api.currentDevice);
                attemptToConnect(api.currentDevice);
            });
        };
        function attemptToConnect ( device ) {
          if (api.connection.state === 'connecting') {
              console.log('DEBUG: Trying device: ' + device.name);
              bluetoothPlugin.connect(device, connectSuccess, connectionErr);
          }
        }
        function connectSuccess() {
            if (api.connection.state === 'connecting'){
                subscribe();
                console.log('DEBUG: Now connected to a port');
                write('X');
                bluetoothPlugin.clear(api.currentDevice, handshake1, simpleLog);
            } else {
                console.log('DEBUG: Connect Success, but wrong state, probably cancelled');
            }
        }
        function handshake1() {
            if (api.connection.state === 'connecting'){
            // pollingTimeout = $timeout(function(){
                waitForInput('A',true,connectionRepeat,api.connection.initialWait,97,0,handshake2);
            // },2000);
            } else {
                console.log('DEBUG: Handshake1, but wrong state, probably cancelled');
            }
        }
        function handshake2(){
            if (api.connection.state === 'connecting'){
                console.log('DEBUG: Received "a", writing "1".  (FlexVolt found!)');
                waitForInput('1',true,connectionRepeat,api.connection.initialWait,98,0,handshake3);
            } else {
                console.log('DEBUG: Handshake2, but wrong state, probably cancelled');
            }
        }
        function handshake3(){
            if (api.connection.state === 'connecting'){
                console.log('DEBUG: Received "b", handshake complete.');
                api.flexvoltPortList.push(api.currentDevice);
                api.connection.flexvoltName = api.currentDevice.name;
                api.connection.bluetoothType = api.currentDevice.bluetoothLE ? 'ble':'classic';
                api.connection.state = 'connected';
                connectionTestInterval = $interval(checkConnection,1000);
                console.log('INFO: Connected to ' + JSON.stringify(api.currentDevice));
                updateSettingsRepeatCount = 0;
                api.pollVersion()
                   .then(api.pollBattery)
                   .then(api.updateSettings)
                   .catch(function(err){console.log('poll/update caught with msg: '+err);});
             } else {
                console.log('DEBUG: Handshake3, but wrong state, probably cancelled');
             }
        }
        function testHandshake(cb){
            waitForInput('Q',true,connectedRepeat,api.connection.connectedWait,113,0,cb);
        }

        api.resetBluetoothModule = function() {
            deferred.resetBluetoothModule = $q.defer();
            if (api.connection.version > api.versionMinimums.resetBluetoothModule) {
                if (api.connection.state === 'connected') {
                    api.connection.state = 'resettingBluetoothModule';
                    bluetoothPlugin.clear(
                        api.currentDevice,
                        function () {
                            waitForInput('R',false,connectedRepeat,api.connection.connectedWait,114,0,confirmResetBluetoothModule);
                        },
                        function(){console.log('ERROR: Error clearing bluetoothPlugin in resetBluetoothModule');}
                    );
                } else {
                  var msg = 'Cannot Reset Bluetooth Module - Not Connected';
                  console.log('WARNING' + msg);
                  deferred.resetBluetoothModule.reject(msg);
                }
            } else {
                var msg2 = 'Cannot reset bluetooth module - older version sensor';
                console.log('DEBUG: ' + msg2);
                deferred.resetBluetoothModule.reject(msg2);
            }
            return deferred.resetBluetoothModule.promise;

            function confirmResetBluetoothModule() {
                if (api.connection.state === 'resettingBluetoothModule') {
                    bluetoothPlugin.clear(
                        api.currentDevice,
                        function () {
                            waitForInput('!',false,connectedRepeat,api.connection.connectedWait,35,0,finalizeResetBluetoothModule);
                        },
                        function(){
                            var msg2 = 'Error clearing bluetoothPlugin in confirmResetBluetoothModule';
                            console.log('ERROR: ' + msg2);
                            deferred.resetBluetoothModule.reject(msg2);
                        }
                    );
                } else {
                  var msg = 'Cannot Confirm Reset Bluetooth Module - not in proper connection state: ' + api.connection.state;
                  console.log('WARNING' + msg);
                  deferred.resetBluetoothModule.reject(msg);
                }
            }

            function finalizeResetBluetoothModule() {
                // do stuff
                api.connection.state = 'connected';
                api.disconnect();
                deferred.resetBluetoothModule.resolve();
                console.log('DEBUG: Finished reseting bluetooth module.');
                console.log('Ask user to restart sensor and wait several minutes before connecting.');
            }
        };

        api.pollVersion = function(){
            deferred.polling = $q.defer();
            if (api.connection.state === 'connected') {
                api.connection.state = 'polling';
                bluetoothPlugin.clear(
                    api.currentDevice,
                    function () {
                        waitForInput('V',false,connectedRepeat,api.connection.connectedWait,118,4,parseVersion);
                    },
                    function(){console.log('ERROR: Error clearing bluetoothPlugin in pollVersion');}
                );
            } else {
              var msg = 'Cannot Poll Version - Not Connected';
              console.log('WARNING' + msg);
              deferred.polling.reject(msg);
            }
            return deferred.polling.promise;

            function parseVersion(){
                console.log('DEBUG: parsing version. dIn: ' + JSON.stringify(dIn));
                write('Q');
                $timeout(function(){
                    if (deferred.polling) {
                        // console.log('DEBUG: deferred polling dIn: ' + JSON.stringify(dIn));
                        if (dIn.length >= 5 && dIn[0] === 118){
                            // console.log('DEBUG: version parsing input: ' + JSON.stringify(dIn));
                            api.connection.state = 'connected';
                            // dIn[0] = 118
                            var data = dIn.slice(1,5);
                            api.connection.version = Number(data[0]);
                            api.connection.serialNumber = Number((data[1]*(2^8))+data[2]);
                            api.connection.modelNumber = Number(data[3]);
                            // var voltageTemp = Number(data[4]);
                            // updateBatteryVoltage(voltageTemp);
                            api.connection.model = MODEL_LIST[api.connection.modelNumber];
                            if (api.connection.modelNumber <= 2) {
                              // It's a USB connection - 5 Volts
                              hardwareLogic.settings.vMax = VMaxUSB;
                              factor8Bit = FactorUSB8Bit;
                              factor10Bit = FactorUSB10Bit;
                            } else if (api.connection.modelNumber >= 3) {
                              // It's a Bluetooth connection, and 3.7 V battery
                              hardwareLogic.settings.vMax = VMaxBattery;
                              factor8Bit = FactorBattery8Bit;
                              factor10Bit = FactorBattery10Bit;
                            }
                            console.log('INFO: Version = '+api.connection.version+
                                        '. SerialNumber = '+api.connection.serialNumber+
                                        '. MODEL = '+api.connection.model.name +
                                        '. Channels = '+api.connection.model.channels +
                                        ', from model# '+api.connection.modelNumber +
                                        ', supply voltage max = '+hardwareLogic.settings.vMax +
                                        ', factors: 8Bit: ' + factor8Bit + ', 10Bit: ' + factor10Bit);
                            if (hardwareLogic.settings.nChannels > api.connection.model.channels) {
                              console.log('INFO: Hardware Settings \'Channels\' was set to ' +
                                          hardwareLogic.settings.nChannels + ', but the currently connect model, ' +
                                          api.connection.model.name + ' only has ' + api.connection.model.channels +
                                          '.  Reseting hardware channels to ' + api.connection.model.channels + '.');
                              hardwareLogic.settings.nChannels = api.connection.model.channels;
                            }
                            dIn = dIn.slice(4);
                            deferred.polling.resolve();
                        } else {
                            deferred.polling.reject('ERROR: did not receive version information');
                        }
                    }
                }, 200);
            }
        };

        api.getIsBatteryLevelAvailable = function(){
          if (api.connection.version >= BREAKING_CHANGE_POLL_BATTERY) {
            return true;
          } else {
            return false;
          }
        };

        api.pollBattery = function(){
            deferred.pollingBattery = $q.defer();
            if (api.connection.version >= BREAKING_CHANGE_POLL_BATTERY) {
                if (api.connection.state === 'connected') {
                    api.connection.state = 'polling';
                    bluetoothPlugin.clear(
                        api.currentDevice,
                        function () {
                            waitForInput('T',false,connectedRepeat,api.connection.connectedWait,116,1,parseBatteryInfo);
                        },
                        function(){console.log('ERROR: Error clearing bluetoothPlugin in pollBattery');}
                    );
                } else {
                  var msg = 'Cannot Poll Battery - Not Connected';
                  console.log('WARNING' + msg);
                  deferred.pollingBattery.reject(msg);
                }
            } else {
                console.log('DEBUG: Cannot poll battery - older version sensor');
                deferred.pollingBattery.resolve();
            }
            return deferred.pollingBattery.promise;

            function parseBatteryInfo(){
                // console.log('DEBUG: parsing battery info');
                write('Q');
                $timeout(function(){
                    if (deferred.pollingBattery) {
                        // console.log('DEBUG: deferred polling battery');
                        if (dIn.length >= 1){
                            // console.log('DEBUG: battery parsing input: ' + JSON.stringify(dIn));
                            api.connection.state = 'connected';
                            var data = dIn.slice(0,1);
                            var voltageTemp = Number(data[0]);
                            updateBatteryVoltage(voltageTemp);
                            dIn = dIn.slice(1);
                            deferred.pollingBattery.resolve();
                        } else {
                            deferred.pollingBattery.reject('ERROR: did not receive battery information');
                        }
                    }
                }, 200);
            }
        };

        function showBLEDataRateWarning(n) {
            if (generalData.settings.userChoices.showBLEDataRateWarning) {
                var iOSDataRatePopup = $ionicPopup.confirm({
                    title: 'Warning - Inappropriate Settings',
                    template: 'Current setting of ' + hardwareLogic.settings.nChannels +
                      ' channels in \'unfiltered\' data mode may not function properly.  '+
                      'Your sensor uses bluetooth low energy, which does not support the necessary data rate.  '+
                      'Data rate will be reduced by a factor of ' + n + '.',
                    buttons: [
                      { text: 'OK'},
                      {
                          text: 'Stop Showing This Message',
                          onTap: function(e){
                              generalData.settings.userChoices.showBLEDataRateWarning = false;
                              generalData.updateSettings();
                          }
                      }
                    ]
                });
            }
        }

        api.validateSettings = function() {
            // General Validations

            // timing adjustment
            var tmp = hardwareLogic.timerAdjustments.frequencyDefaults[hardwareLogic.settings.frequency];
            if (tmp) {
                hardwareLogic.settings.timer0AdjustVal = tmp.timer0AdjustVal;
                hardwareLogic.settings.timer0PartialCount = tmp.timer0PartialCount;
            } else {
                hardwareLogic.settings.timer0AdjustVal = hardwareLogic.timerAdjustments.defaultTimer0AdjustVal;
                hardwareLogic.settings.timer0PartialCount = hardwareLogic.timerAdjustments.defaultTimer0PartialCount;
            }

            // Downsample adjustments
            // Firmware won't downsample in 'raw' mode.  Only in 'filtered' mode
            if (!hardwareLogic.settings.smoothFilterFlag) {
                //console.log('fixing downSampleCount');
                hardwareLogic.settings.downSampleCount = 1;
            }

            // Version specific Validations
            if (api.connection.version >= BREAKING_CHANGE_ONBOARD_RMS_VERSION){
                // new settings.  Only allow smoothFilterMode_RMS if nChannels <= 4
                // the PIC doesn't operate fast enough to perform RMS for 8 channels.
                if (hardwareLogic.settings.nChannels > ONBOARD_RMS_MAX_CHANNELS) {
                    console.log('DEBUG: 8 channels and smoothing requested.  Dropping smooth filter mode to \'shift\'.');
                    hardwareLogic.settings.smoothFilterMode = hardwareLogic.constants.smoothFilterMode_Shift;
                } else if (hardwareLogic.settings.nChannels <= ONBOARD_RMS_MAX_CHANNELS) {
                    console.log('DEBUG: < 8 channels and smoothing requested.  Setting smooth filter mode to \'RMS\'.');
                    hardwareLogic.settings.smoothFilterMode = hardwareLogic.constants.smoothFilterMode_RMS;
                }
            } else if (api.connection.version < BREAKING_CHANGE_ONBOARD_RMS_VERSION) {
                // older versions don't send 10-bit with filter, even if asked for 10 bit
                if (hardwareLogic.settings.smoothFilterFlag) {
                    //console.log('fixing bitDepth10');
                    hardwareLogic.settings.bitDepth10 = false;
                }
            }

            // downsampling
            if (hardwareLogic.settings.smoothFilterFlag) {
                if (api.connection.bluetoothType === 'ble') {
                    // BLE max rate is ~2kSps.  downsample by 16 to achieve ~1ksPs for 8 channels.
                    if (hardwareLogic.settings.downSampleCount < 10) {
                        hardwareLogic.settings.downSampleCount = 10;
                    }
                } else if (api.connection.bluetoothType === 'classic') {
                    // Bluetooth Classic can handle full data rate for 8 channels at 1kHz
                    if (hardwareLogic.settings.downSampleCount < 10) {
                        hardwareLogic.settings.downSampleCount = 10;
                    }
                }

            } else {
                // raw mode.  If not BLE, reset downSampleCount to 1.
                if (api.connection.bluetoothType === 'ble') {
                    if (hardwareLogic.settings.nChannels === 1) {
                        // iOS BLE can handle 1 channel at 1kHz.
                        hardwareLogic.settings.downSampleCount = 1;
                    } else {
                        // set downSampleCount to the same value as nChannels.
                        if (hardwareLogic.settings.downSampleCount < hardwareLogic.settings.nChannels){
                            showBLEDataRateWarning(hardwareLogic.settings.nChannels);
                            hardwareLogic.settings.downSampleCount = hardwareLogic.settings.nChannels;
                        }
                    }
                } else {
                    // Bluetooth Classic can handle full data rate for 8 channels at 1kHz
                    hardwareLogic.settings.downSampleCount = 1;
                }
            }

            console.log('INFO: hardware settings validation resolved to: '+angular.toJson(hardwareLogic.settings));

            // store changes
            hardwareLogic.updateSettings();
        };

        api.updateSettings = function(){

          /* Register Control Words
           *
           * Example:
           *
           * REG0 = 157
           * in binary 157 = 0b10011101
           * 0b**10**011101 => 4 Channels
           * 0b10**0111**01 => Frequency Index = 7 => 500Hz
           * 0b100111**0**1 => Send Raw Data
           * 0b1001110**1** => Use 10-bit resolution
           *
           *
           * REG0 Is most likely the only register to be adjusted
           *
           * REG0 = main/basic user settings
           * REG0<7:6> = Channels, DEFAULTS to current connected hardware.  11=8, 10=4, 01=2, 00=1
           * REG0<5:2> = FreqIndex, DEFAULT=8 (1000Hz), FREQUENCY_LIST = [1, 10, 50, 100, 200, 300, 400, 500, 1000, 1500, 2000];
           * REG0<1> = DataMode DEFAULT=0, (1 = filtered, 0 = raw)
           * REG0<0> = Data bit depth.  DEFAULT = 0.  1 = 10-bits, 0 = 8-bits
           *
           * Registers below deal with microprocessor fine timing adjustements, digital filter (prior to transmission)
           * custom sampling frequencies, downsampling, and plugin-detection
           *
           * REG1 = Filter Shift Val + Prescalar Settings
           * REG1<4:0> = filter shift val, 0:31, 5-bits
           * REG1<7:5> = PS setting.
           *              000 = 2
           *              001 = 4
           *              010 = 8 [DEFAULT]
           *              011 = 16 // not likely to be used
           *              100 = 32 // not likely to be used
           *              101 = 64 // not likely to be used
           *              110 = 128// not likely to be used
           *              111 = off (just use 48MHz/4)
           *
           * * REG2 = [OLD - Manual Frequency, low byte (16 bits total)]
           * * REG3 = [Old - Manual Frequency, high byte (16 bits total).  [DEFAULT = 0]]
           *
           * REG2 = HP Filter + RESERVED
           * REG2<7> = High Pass Filter (1 = filter on, 0 = filter off)
           * REG2<6> = Smooth Filter Mode (1 = RMS Filter, 0 = Smooth Shift Filter)
           * REG2<5:1> = RESERVED
           * REG2<0> = Battery Test (1 = on, 0 = off)
           *
           * REG3 - RESERVED
           *
           * REG4 = Time adjust val (8bits, use 0:255 to achieve -6:249) [DEFAULT=2 => -4]
           *
           * REG5 & REG6 Timer Adjustment   [DEFAULT = 0]
           * (add Time Adjust to x out of N total counts to 250)
           * REG5<7:0> = partial counter val, low byte, 16 bits total
           * REG6<7:0> = partial counter val, high byte, 16 bits total
           *
           * REG7<7:0> = down sampling value (mainly for smoothed data)  [DEFAULT = 0]
           *
           * REG8<7:0> = Plug Test Delay (ms).  [DEFAULT=0] If 0, no plug tests.  If greater than 0, returns result of plug test every delay ms.
           */
            api.validateSettings();

            deferred.updateSettings = $q.defer();
            if (api.connection.state === 'updating settings'){
                console.log('DEBUG: already updating settings.  Will update again when done in case changes were made during udpate process');
                updateSettingsAgainRequested = true;
            } else if (api.connection.state === 'connected'){
                console.log('INFO: Updating Settings');
                if (api.connection.data === 'on' || api.connection.data === 'turningOn') {
                  // need to turn data off first!  Set dataOnRequested so it
                  // gets turned back on after settings update
                  api.connection.dataOnRequested = true;
                  turnDataOff()
                    .then(function(){
                      api.connection.state = 'updating settings';
                      waitForInput('S',false,connectedRepeat,api.connection.connectedWait,115,0,updateSettings2);
                    });
                } else {
                  api.connection.state = 'updating settings';
                  waitForInput('S',false,connectedRepeat,api.connection.connectedWait,115,0,updateSettings2);
                }
            } else if (api.connection.state === 'polling') {
                var msg1 = 'Cannot Update Settings - polling.  Trying again in 200ms.';
                console.log('WARNING: ' + msg1);
                $timeout(function(){
                  if (api.connection.state === 'connected'){
                    console.log('INFO: Updating Settings');
                    api.connection.state = 'updating settings';
                    waitForInput('S',false,connectedRepeat,api.connection.connectedWait,115,0,updateSettings2);
                  } else {
                    var msg2 = 'Cannot Update Settings - still polling or not connected';
                    console.log('WARNING: ' + msg2);
                    deferred.updateSettings.reject(msg2);
                  }
                }, 200);
            } else {
                var msg3 = 'Cannot Update Settings - not connected';
                console.log('WARNING: ' + msg3);
                deferred.updateSettings.reject(msg3);
            }

            return deferred.updateSettings.promise;

            function updateSettings2(){
                if (deferred.updateSettings) {
                    console.log('DEBUG: Update Settings 2');
                    var REG = [];
                    var REGtmp = 0;
                    var tmp = 0;

                    //Register 0
                    if (hardwareLogic.settings.nChannels === 8)tmp = 3;
                    if (hardwareLogic.settings.nChannels === 4)tmp = 2;
                    if (hardwareLogic.settings.nChannels === 2)tmp = 1;
                    if (hardwareLogic.settings.nChannels === 1)tmp = 0;
                    REGtmp = tmp << 6;

                    var frequencyIndex = FREQUENCY_LIST.indexOf(hardwareLogic.settings.frequency);
                    REGtmp += frequencyIndex << 2;
                    tmp = 0;
                    if (hardwareLogic.settings.smoothFilterFlag) {
                        tmp = 1;
                    }
                    REGtmp += tmp << 1;
                    tmp = 0;
                    if (hardwareLogic.settings.bitDepth10) {
                        tmp = 1;
                    }
                    REGtmp += tmp;
                    REG.push(REGtmp); // 11110100 (252)

                    // Register 1
                    REGtmp = 0;
                    REGtmp += hardwareLogic.settings.prescalerPic << 5;
                    if (api.connection.version >= BREAKING_CHANGE_ONBOARD_RMS_VERSION) {
                        if (hardwareLogic.settings.smoothFilterMode === hardwareLogic.constants.smoothFilterMode_RMS) {
                            var rmsWindowIndex = hardwareLogic.settings.rmsWindowSizePower;
                            REGtmp += rmsWindowIndex;
                        } else if (hardwareLogic.settings.smoothFilterMode === hardwareLogic.constants.smoothFilterMode_Shift) {
                            var smoothFilterShiftVal = hardwareLogic.settings.smoothFilterVal;
                            REGtmp += smoothFilterShiftVal;
                        }
                    } else if (api.connection.version < BREAKING_CHANGE_ONBOARD_RMS_VERSION) {
                        REGtmp += hardwareLogic.settings.smoothFilterVal;
                    }
                    REG.push(REGtmp); // 01001000 72

                    // Register 2
                    if (api.connection.version >= BREAKING_CHANGE_ONBOARD_RMS_VERSION) {
                        // Custom frequency register hijacked for filter switches

                        // HP filter
                        REGtmp = 0;
                        if (hardwareLogic.settings.hpFilterFlag) {
                          REGtmp = REGtmp | HP_FILTER_ON;
                        }

                        // smooth filter mode (default is shift filter)
                        if (hardwareLogic.settings.smoothFilterMode === hardwareLogic.constants.smoothFilterMode_RMS) {
                            REGtmp = REGtmp | SMOOTH_FILTER_MODE_RMS;
                        } else if (hardwareLogic.settings.smoothFilterMode === hardwareLogic.constants.smoothFilterMode_Shift) {
                            REGtmp = REGtmp | SMOOTH_FILTER_MODE_SHIFT;
                        }

                        if (hardwareLogic.settings.enableBatteryTest) {
                            REGtmp = REGtmp | ENABLE_BATTERY_TEST;
                        }

                    } else if (api.connection.version < BREAKING_CHANGE_ONBOARD_RMS_VERSION) {
                        // original custom frequency register
                        REGtmp = hardwareLogic.settings.frequencyCustom;
                        REGtmp = (Math.round(REGtmp >> 8)<<8);
                        REGtmp = hardwareLogic.settings.frequencyCustom-REGtmp;
                    }
                    REG.push(REGtmp); // 00000000

                    // Register 3
                    if (api.connection.version >= BREAKING_CHANGE_ONBOARD_RMS_VERSION) {
                        // Custom frequency register hijacked for HP filter switch
                        REGtmp = 0;
                    } else {
                        // original custom frequency register
                        REGtmp = hardwareLogic.settings.frequencyCustom>>8;
                    }
                    REG.push(REGtmp); // 00000000

                    // Register 4
                    REGtmp = hardwareLogic.settings.timer0AdjustVal+6;
                    REG.push(REGtmp); // 00001000 8

                    // Register 5
                    REGtmp = hardwareLogic.settings.timer0PartialCount & 0xFF;
                    REG.push(REGtmp); // 00000000

                    // Register 6
                    REGtmp = (hardwareLogic.settings.timer0PartialCount>>8) & 0xFF;
                    REG.push(REGtmp); // 00000000

                    // Register 7
                    REGtmp = hardwareLogic.settings.downSampleCount;
                    REG.push(REGtmp); // 00000001 1

                    // Register 8
                    REGtmp = hardwareLogic.settings.plugTestDelay;
                    REG.push(REGtmp);

                    var msg = '';
                    for (var i = 0; i < REG.length; i++){
                        msg += REG[i]+', ';
                    }
                    console.log('DEBUG: Updated Settings to: REG='+msg);

                    // writeArray(REG);
                      // .then(updateSettings3);
                    // waitForInput(null,false,connectedRepeat,api.connection.connectedWait,121,0,updateSettings3);

                    updateSettingsCurrentRegisterIndex = 0;

                    var sendNextRegisterValue = function() {
                        var val = REG[updateSettingsCurrentRegisterIndex];
                        console.log('DEBUG: Sending register val[' + updateSettingsCurrentRegisterIndex + '] = ' + val);
                        var correctResponse = [val,updateSettingsCurrentRegisterIndex,val];
                        updateSettingsCurrentRegisterIndex ++;
                        dIn = [];
                        if (updateSettingsCurrentRegisterIndex < REG.length) {
                          waitForInput(val,false,connectedRepeat,api.connection.connectedWait,correctResponse,0,sendNextRegisterValue);
                        } else {
                          correctResponse.push(121); // add the value we expect when done
                          waitForInput(val,false,connectedRepeat,api.connection.connectedWait,correctResponse,0,updateSettings3);
                        }
                    };

                    sendNextRegisterValue();
                }
            }
            function updateSettings3(){
                if (deferred.updateSettings) {
                    console.log('DEBUG: Update Settings 3');
                    waitForInput('Y',false,connectedRepeat,api.connection.connectedWait,122,0,updateDataSettings);
                }
            }
            function updateDataSettings(){
                if (deferred.updateSettings) {
                    api.connection.state = 'connected';
                    updateSettingsRepeatCount = 0;
                    /* settings read parameters
                     * 67'C' = 8 bits, 1ch, 2 Bytes
                     * 68'D' = 8 bits, 2ch, 3 Bytes
                     * 69'E' = 8 bits, 4ch, 5 Bytes
                     * 70'F' = 8 bits, 8ch, 9 Bytes
                     *  don't use 10-bit!  the bottom 2 bits of most ADCs are noise anyway!
                     * 72'H' = 10bits, 1ch, 3 Bytes
                     * 73'I' = 10bits, 2ch, 4 Bytes
                     * 74'J' = 10bits, 4ch, 6 Bytes
                     * 75'K' = 10bits, 8ch, 11 Bytes
                     */

                    if (!hardwareLogic.settings.bitDepth10){
                        api.readParams.offset = 128;
                        if (hardwareLogic.settings.nChannels === 1){
                            api.readParams.expectedChar = 67;
                            api.readParams.expectedBytes = 2;
                        } else if (hardwareLogic.settings.nChannels === 2){
                            api.readParams.expectedChar = 68;
                            api.readParams.expectedBytes = 3;
                        } else if (hardwareLogic.settings.nChannels === 4){
                            api.readParams.expectedChar = 69;
                            api.readParams.expectedBytes = 5;
                        } else if (hardwareLogic.settings.nChannels === 8){
                            api.readParams.expectedChar = 70;
                            api.readParams.expectedBytes = 9;
                        }
                    } else if (hardwareLogic.settings.bitDepth10){
                        api.readParams.offset = 512;
                        if (hardwareLogic.settings.nChannels === 1){
                            api.readParams.expectedChar = 72;
                            api.readParams.expectedBytes = 3;
                        } else if (hardwareLogic.settings.nChannels === 2){
                            api.readParams.expectedChar = 73;
                            api.readParams.expectedBytes = 4;
                        } else if (hardwareLogic.settings.nChannels === 4){
                            api.readParams.expectedChar = 74;
                            api.readParams.expectedBytes = 6;
                        } else if (hardwareLogic.settings.nChannels === 8){
                            api.readParams.expectedChar = 75;
                            api.readParams.expectedBytes = 11;
                        }
                    }
                    console.log('INFO: Updated settings');
                    console.log('DEBUG: read params: '+JSON.stringify(api.readParams));
                    if (updateSettingsAgainRequested) {
                        updateSettingsAgainRequested = false;
                        console.log('DEBUG: User changed hardware settings while running sensor update process.  Running again.');
                        api.updateSettings();
                    } else {
                        deferred.updateSettings.resolve();
                        checkIsDataOnRequested();
                    }

                }
            }
        };

        function checkIsDataOnRequested() {
          if (api.connection.dataOnRequested){
              console.log('DEBUG: dataOnRequested');
              turnDataOn();
          }
        }

        function turnDataOn(){
            console.log('DEBUG: turning data on');

            if (api.connection.state === 'connected'){
                api.connection.data = 'turningOn';
                bluetoothPlugin.clear(
                    api.currentDevice,
                    function () {
                        console.log('DEBUG: Cleared in turnDataOn.');
                        waitForInput('G',true,connectedRepeat,api.connection.connectedWait,103,0,function(){
                            console.log('INFO: Turned data on');
                            api.connection.data = 'on';
                        });
                    },
                    function(msg){
                        api.connection.data = 'off';
                        console.log('ERROR: in clear in turnDataOn: ' + JSON.stringify(msg));
                    }
                );
            } else if (api.connection.state === 'update settings' || api.connection.state === 'polling' || api.connection.state === 'connecting'){
                console.log('DEBUG: dataOn fail - still initializing');
                api.connection.data = 'off';
            } else {
                console.log('WARNING: dataOn fail - not connected');
                api.connection.data = 'off';
            }
        }
        function turnDataOff(){ // 113 = 'q'
            console.log('DEBUG: turning data off');
            deferred.turnDataOff = $q.defer();
            if (api.connection.data === 'on'){
                api.connection.data = 'turningOff';
                dIn = [];
                waitForInput('Q',true,connectedRepeat,api.connection.connectedWait,113,0,function(){
                    console.log('INFO: Turned data off.');
                    api.connection.data = 'off';
                    deferred.turnDataOff.resolve();
                });
            }  else {
              console.log('DEBUG: dataOff failed - data not on');
              deferred.turnDataOff.resolve();
            }

            return deferred.turnDataOff.promise;
        }
        api.getDataParsed = function(){
            var tmpLow, tmpLow2, iChan;
            var dataParsed = [];
            var dataTimes = [];
            if (!checkingForData && api.connection.state === 'connected' && api.connection.data === 'on'){
                checkingForData = true;
                var dataIn = dIn.slice(0);
                if (dataIn.length >= api.readParams.expectedBytes){
                    // initialize parsed data vector
                    dataParsed = new Array(hardwareLogic.settings.nChannels);
                    for (iChan = 0; iChan < hardwareLogic.settings.nChannels; iChan++){ dataParsed[iChan]=[]; }
                    dataTimes = [];
                    // Parse channels
                    var readInd = 0, dataInd = 0;
                    while(readInd < (dataIn.length-api.readParams.expectedBytes) ){
                        var tmp = dataIn[readInd++];
                        if (tmp === api.readParams.expectedChar){
                            dataTimes.push(timestamp); timestamp+=timestampInterval*hardwareLogic.settings.downSampleCount;
                            if (!hardwareLogic.settings.bitDepth10) {
                                for (iChan = 0; iChan < hardwareLogic.settings.nChannels; iChan++){
                                    dataParsed[iChan][dataInd] = factor8Bit*(dataIn[readInd++] - api.readParams.offset); // centering on 0!
                                }
                                dataInd++;
                            } else if (hardwareLogic.settings.bitDepth10) {
                                tmpLow = dataIn[readInd+hardwareLogic.settings.nChannels];
                                if (hardwareLogic.settings.nChannels > 4) {
                                  tmpLow2 = dataIn[readInd+hardwareLogic.settings.nChannels+1];
                                }
                                for (iChan = 0; iChan < Math.min(4, hardwareLogic.settings.nChannels); iChan++){
                                    dataParsed[iChan][dataInd] = factor10Bit*((dataIn[readInd++]<<2) + ((tmpLow>>(2*(3-iChan))) & 3) - api.readParams.offset); // centering on 0!
                                }
                                for (iChan = 4; iChan < hardwareLogic.settings.nChannels; iChan++){
                                    dataParsed[iChan][dataInd] = factor10Bit*((dataIn[readInd++]<<2) + ((tmpLow2>>(2*(3-iChan))) & 3) - api.readParams.offset); // centering on 0!
                                }
                                readInd++; // for the tmpLow read
                                if (hardwareLogic.settings.nChannels > 4) {
                                  readInd++; // for the tmpLow2 read
                                }
                                dataInd++;
                            }

                        } else if (tmp === 116) { //'t' - voltage statement
                            var batteryVoltage = dataIn[readInd++];
                            console.log('INFO: Got Battery Level: ' + JSON.stringify(batteryVoltage));
                            updateBatteryVoltage(batteryVoltage);
                            break; // kick back out - don't want to add logic hear to figure out if we still have a full data point available
                        } else {
                            console.log('WARNING: unexpected Char '+tmp);
                        }
                    }
                    // Remove read samples from the incoming data array
                    dIn = dIn.slice(readInd);
                }
                checkingForData = false;
            }
            // copy, clear, return.  REMEMBER - bluetoothPlugin is ASYNC!
            return [dataTimes, dataParsed];
        };

        function updateBatteryVoltage(valFromPic) {
            var adcFullScale = 255;
            var adcVRef = 1.024;
            var vddMultiplier = 8;
            // console.log('DEBUG: valFromPic: ' + JSON.stringify(valFromPic));
            // valFromPic is measured using ADC ref of 1.024V.
            // [0, 255] => [0, 1.024]V
            valFromPic += 1;  // empirical - seems to always read a little low.
            // PIC V+ is routed to ADC via ADC_IN = V+ * 4 / 32
            var adcVoltage = (valFromPic / adcFullScale) * adcVRef;
            // console.log('DEBUG: adcVoltage: ' + adcVoltage);

            // adc input comes from DAC output.  DAC output = Vdd / 8.  ie 4.2V => .525
            // 4.2 => .525/1.024 => @1023 524, @255 131
            // 3.0 => .375/1.024 => @1023 374, @255 93
            var vdd = adcVoltage * vddMultiplier;
            console.log('DEBUG: Battery Voltage: ' + JSON.stringify(vdd));
            api.connection.batteryVoltage = vdd;
            api.updateBatteryIndicator();
        }

        // @input data String
        function write( char ) {
            bluetoothPlugin.write(api.currentDevice, char, function(){}, simpleLog);
        }
        function writeArray( array ) {
            bluetoothPlugin.writeArray(api.currentDevice, array, function(){}, simpleLog);
        }

        api.turnDataOn = function(){
            api.connection.dataOnRequested = true;
            api.resetTiming();
            turnDataOn();
        };
        api.resetTiming = function(){
            $interval.cancel(timingCheckInterval);
            timestampInterval = 1000/hardwareLogic.settings.frequency; // millis
            timestamp = Date.now(); // start the timer (millis) NOTE it will lag real time by however long it takes to turn data on
            // check on the timing, correct every 5s
            timingCheckInterval = $interval(function(){
                // var delta = Date.now() - timestamp;
                // console.log('Timeing Detla: ' + delta);
                timestamp=Date.now();
            },5000);
            console.log('INFO: TimestampInterval: ' + timestampInterval + '.  Timestamp: ' + timestamp);
        };
        api.turnDataOff = function(){
            api.connection.dataOnRequested = false;
            $interval.cancel(timingCheckInterval);
            turnDataOff();
        };

        api.startConnect = function(){
          console.log('DEBUG: startConnect');
          api.discoverFlexVolts()
             .then(tryPorts)
             .catch(function(msg){
               console.log('DEBUG: startConnect disconnected with msg: '+msg);
             });
        };

        init();
        // This starts it all!
        $timeout(api.startConnect, DISCOVER_DELAY_MS);

        $interval(
            function(){
                if (api.connection.state === 'connected') {
                  if (api.connection.data === 'on') {
                    return;
                  } else {
                    api.pollBattery()
                      .then(checkIsDataOnRequested);
                  }
                }
            }, 60000);

        function updateDots(){
            dots += '. ';
            if (dots.length > 12){
                dots = '';
            }
        }

        $interval(updateDots, 400);
    });
    return {
        api : api,
        getConnectingStatus: function(){
          return api.connection.state === 'searching' || api.connection.state === 'connecting';
        },
        getConnectionStatus: function(){
            return api.connection.state === 'connected' || api.connection.state === 'polling' || api.connection.state === 'updating settings';
        },
        getDetailedConnectionStatus: function(){
            if (api.connection.state === 'begin'){
                return 'Not Connected.  Try \'Scan\' or select device below.';
            } else if (api.connection.state === 'searching'){
                return 'Scanning available ports for FlexVolts.' + dots;
            } else if (api.connection.state === 'connecting'){
                return 'Connecting to ' + api.currentDevice.name + '. ' + dots;
            } else if (api.connection.state === 'reconnecting'){
                return 'Reconnecting with ' + api.connection.flexvoltName + '. ' + dots;
            } else if (api.connection.state === 'connected'){
                return 'Connected';
            } else if (api.connection.state === 'polling'){
                return 'Getting device info' + dots;
            } else if (api.connection.state === 'updating settings'){
                return 'Updating device settings' + dots;
            } else if (api.connection.state === 'no flexvolts found'){
                return 'No FlexVolt devices found.  Is your FlexVolt powered on and paired/connected?';
            } else {return 'Info not avaiable.';}
        },
        getPortList: function(){
            if (api.connection.state === 'connected' ||
                api.connection.state === 'polling' ||
                api.connection.state === 'updating settings') {
                  var list = devices.getAll().slice(0);
                  list.splice(list.findIndex(function(elem){return elem.name === api.connection.flexvoltName;}),1);
                  return list;
            } else {
              return devices.getAll();
            }
        },
        getPrefPortList: function(){
            return devices.getPreferred();
        }
    };
  }]);

  }());
