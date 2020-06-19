/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');
const io = require('engine.io-client');
const debug = require('debug')('engineio');
const engineUtil = require('./engine_util');
const template = engineUtil.template;

module.exports = EngineIoEngine;

function EngineIoEngine(script) {
  this.config = script.config;
}

EngineIoEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

EngineIoEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue || '$loopCount',
        overValues: requestSpec.over,
        whileTrue: self.config.processor ?
          self.config.processor[requestSpec.whileTrue] : undefined
      });
  }

  if (requestSpec.think) {
    return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
  }

  if (requestSpec.function) {
    return function(context, callback) {
      let processFunc = self.config.processor[requestSpec.function];
      if (processFunc) {
        processFunc(context, ee, function () {
          return callback(null, context);
        });
      }
    }
  }

  let f = function(context, callback) {
    ee.emit('counter', 'engine.websocket.messages_sent', 1);
    ee.emit('rate', 'engine.websocket.send_rate')

    let payload = template(requestSpec.send, context);
    if (typeof payload === 'object') {
      payload = JSON.stringify(payload);
    } else {
      payload = payload.toString();
    }

    debug('Socket send: %s', payload);

    context.socket.send(payload, function(err) {
      if (err) {
        debug(err);
        ee.emit('error', err);
      }
      return callback(err, context);
    });
  };

  return f;
};

EngineIoEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;

  return function scenario(initialContext, callback) {
    function zero(callback) {
      let tls = config.tls || {};
      let engineioOps = config.engineio || {};
      let options = _.extend(tls, engineioOps);

      ee.emit('started');

      let socket = io(config.target, options);

      socket.on('open', function() {
        initialContext.socket = socket;
      });

      socket.on('message', (m) => {
        if (JSON.parse(m).type === 'ready') {
          return callback(null, initialContext);
        }
      })

      socket.once('error', function(err) {
        debug(err);
        ee.emit('error', err.message || err.code);
        return callback(err, {});
      });
    }

    initialContext._successCount = 0;

    let steps = _.flatten([
      zero,
      tasks
    ]);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        if (err) {
          debug(err);
        }

        if (context && context.socket) {
          context.socket.close();
        }

        return callback(err, context);
      });
  };
};
