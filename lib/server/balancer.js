var debug = require('debug')('micromono:server')
var config = require('../config')
var Router = require('../web/router')
var argsNames = require('js-args-names')
var AssetPipe = require('../web/asset')
var LocalPipe = require('../service/local')
var ServerPipe = require('./pipe')
var RemotePipe = require('../service/remote')
var DiscoveryPipe = require('../discovery/pipe')
var ServerChnPipe = require('./channel')
var ServerPipeline = require('../server/pipeline')
var ServicePipeline = require('../service/pipeline')


module.exports = function startBalancer(app, opts, callback) {
  if ('function' === typeof opts) {
    callback = opts
    opts = undefined
  }
  opts = opts || {}

  var micromono = this
  var packagePath = ServerPipe.getCallerPath()
  debug('Balancer packagePath %s', packagePath)

  var options = config(['server'])
  // Use 3000 as default port for balancer
  options.port = options.MICROMONO_PORT = options.port || 3000
  micromono.config(options)
  micromono.serviceDir = options.serviceDir

  var frameworkType = opts.framework || 'express'
  var framework = ServerPipe.initFramework(frameworkType).framework

  micromono
    .set(Router, '*^')
    .set(AssetPipe, '*^')
    .set(LocalPipe, '*^')
    .set(RemotePipe, '*^')
    .set(ServerPipe, '*^')
    .set(DiscoveryPipe, '*^')
    .set(ServerChnPipe, '*^')
    .set('mainApp', app || undefined)
    .set('require', micromono.require.bind(micromono))
    .set('micromono', micromono)
    .set('mainFramework', framework)
    // Balancer asset management
    .set('balancerPackagePath', packagePath)
    .set('errorHandler', function(err, errPipeName) {
      debug('[%s] `startBalancer` pipeline error', errPipeName, err && err.stack || err)
      process.exit(-1)
    })

  var balancer = ServerPipeline.initBalancer.concat(ServicePipeline.listenRemoteProviders)

  if ('function' === typeof callback)
    balancer.pipe(callback, argsNames(callback))

  balancer
    .error('errorHandler', [null, 'errPipeName'])
    .debug(micromono.get('MICROMONO_DEBUG_PIPELINE') && debug)

  balancer.toPipe(micromono.superpipe, 'startBalancer')()
}
