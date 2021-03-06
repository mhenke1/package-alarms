/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var si = require('systeminformation');
var v8 = require('v8');
var _ = require('lodash');

module.exports = function (logger, manager) {

    // Health Endpoint
    this.endPoint = '/health';

    var triggerName;
    var monitorStatus;
    var alarmTypes = ['interval', 'date', 'cron'];
    var alarmTypeIndex = 0;
    var monitorStages = ['triggerStarted', 'triggerFired', 'triggerStopped'];

    // Health Logic
    this.health = function (req, res) {

        var stats = {triggerCount: Object.keys(manager.triggers).length};

        // get all system stats in parallel
        Promise.all([
            si.mem(),
            si.currentLoad(),
            si.fsSize(),
            si.networkStats(),
            si.inetLatency(manager.routerHost)
        ])
        .then(results => {
            stats.triggerMonitor = monitorStatus;
            stats.memory = results[0];
            stats.cpu = _.omit(results[1], 'cpus');
            stats.disk = results[2];
            stats.network = results[3];
            stats.apiHostLatency = results[4];
            stats.heapStatistics = v8.getHeapStatistics();
            res.send(stats);
        })
        .catch(error => {
            stats.error = error;
            res.send(stats);
        });
    };

    this.monitor = function (apikey) {
        var method = 'monitor';

        var auth = apikey.split(':');
        var userAuth = auth[0]

        if (triggerName) {
            monitorStatus = Object.assign({}, manager.monitorStatus);
            manager.monitorStatus = {};

            var monitorStatusSize = Object.keys(monitorStatus).length;
            if (monitorStatusSize < 5) {
                //we have a failure in one of the stages
                var stageFailed = monitorStages[monitorStatusSize - 2];
                monitorStatus[stageFailed] = 'failed';
            }
            var existingID = `${userAuth}/_/${triggerName}`;

            //delete trigger feed from database
            manager.sanitizer.deleteTriggerFromDB(existingID, 0);

            //delete the trigger
            var triggerData = {
                apikey: apikey,
                uri: manager.uriHost + '/api/v1/namespaces/_/triggers/' + triggerName,
                triggerID: existingID
            };
            manager.sanitizer.deleteTrigger(triggerData, 0)
            .then((info) => {
                logger.info(method, existingID, info);
            })
            .catch(err => {
                logger.error(method, existingID, err);
            });

            var existingAlarmIndex = alarmTypes.indexOf(monitorStatus.triggerType);
            alarmTypeIndex = existingAlarmIndex !== 2 ? existingAlarmIndex + 1 : 0;
        }

        //create new alarm trigger
        triggerName = 'alarms_' + manager.worker + manager.host + '_' + Date.now();
        var alarmType = alarmTypes[alarmTypeIndex];

        //update status monitor object
        manager.monitorStatus.triggerName = triggerName;
        manager.monitorStatus.triggerType = alarmType;

        var triggerURL = manager.uriHost + '/api/v1/namespaces/_/triggers/' + triggerName;
        var triggerID = `${userAuth}/_/${triggerName}`;
        createTrigger(triggerURL, apikey)
        .then((info) => {
            logger.info(method, triggerID, info);
            var newTrigger = createAlarmTrigger(alarmType);
            createTriggerInDB(triggerID, newTrigger);
        })
        .catch(err => {
            logger.error(method, triggerID, err);
        });
    };

    function createAlarmTrigger(alarmType) {

        var newTrigger = {
            name: triggerName,
            namespace: '_',
            payload: {},
            maxTriggers: -1,
            worker: manager.worker,
            monitor: manager.host
        };

        var minuteInterval = 1000 * 60;
        var startDate = Date.now() + minuteInterval;
        if (alarmType === 'interval') {
            newTrigger.minutes = 1;
            newTrigger.startDate = startDate;
            newTrigger.stopDate = startDate + minuteInterval;
        } else if (alarmType === 'date') {
            newTrigger.date = startDate;
        } else {
            newTrigger.cron = '* * * * *';
            newTrigger.stopDate = startDate + minuteInterval;
        }

        return newTrigger;
    }

    function createTrigger(triggerURL, apikey) {

        return new Promise(function (resolve, reject) {
            manager.authRequest({apikey: apikey}, {
                method: 'put',
                uri: triggerURL,
                json: true,
                body: {}
            }, function (error, response) {
                if (error || response.statusCode >= 400) {
                    reject('monitoring trigger create request failed');
                } else {
                    resolve('monitoring trigger create request was successful');
                }
            });
        });
    }

    function createTriggerInDB(triggerID, newTrigger) {
        var method = 'createTriggerInDB';

        manager.db.insert(newTrigger, triggerID, function (err) {
            if (!err) {
                logger.info(method, triggerID, 'successfully inserted monitoring trigger');
            } else {
                logger.error(method, triggerID, err);
            }
        });
    }

};
