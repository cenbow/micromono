var path = require('path')
var isArray = require('lodash.isarray')
var getFnArgs = require('./helper').getFnArgs
var httpProxy = require('http-proxy')


var Router = module.exports = function MicroMonoRouter(service) {
  this.service = service
  this.setFramework(service.framework)

  if (service.route) {
    this._routes = this.normalizeRoutes(service.route, service)
  }
}

/**
 * Get the internal route definition object. Could be used for service announcement.
 * @return {Object} Route definition object.
 */
Router.prototype.getRoutes = function() {
  return this._routes
}

/**
 * Get the internal middleware definition object. Could be used for service announcement.
 * @return {Object} Middleware definition object.
 */
Router.prototype.getMiddlewares = function() {
  return this._middlewares
}

/**
 * Set the framework to use for this router.
 *
 * @param {String|Object} framework The framework adapter name or object.
 */
Router.prototype.setFramework = function(framework) {
  if ('string' === typeof framework) {
    var FrameworkAdapter = require('./framework/' + framework)
    this.framework = new FrameworkAdapter()
  } else {
    this.framework = framework
  }

  return this
}

Router.prototype.startServer = function(port, host) {
  return this.framework.startServer(port, host)
}

/**
 * Normalize route definition to a portable format which could be easily used
 * by different web frameworks.
 *
 * ```javascript
 * route: {
 *   'get::/user/:name': function(req, res) {...}
 * }
 * ```
 *
 * will be formatted into:
 *
 * ```javascript
 * {
 *   name: 'get::/user/:name',
 *   method: 'get',
 *   path: '/user/:name',
 *   handler: [Function],
 *   args: ['req', 'res'],
 *   middleware: null
 * }
 * ```
 *
 * Example with route middleware:
 *
 * ```javascript
 * route: {
 *   'get::/user/:name': [function(req, res, next) {...}, function(req, res) {...}]
 * }
 * ```
 *
 * will be formatted into:
 *
 * ```javascript
 * {
 *   name: 'get::/user/:name',
 *   method: 'get',
 *   path: '/user/:name',
 *   handler: Function,
 *   args: ['req', 'res'],
 *   middleware: [Function]
 * }
 * ```
 *
 * @param {Object}  route   Route definition object.
 * @param {Service} service Instance of service.
 * @return {Object}         Formatted routes object.
 */
Router.prototype.normalizeRoutes = function(route, service) {
  var _routes = {}
  var proxyHandler
  if (service.isRemote()) {
    proxyHandler = this.getProxyHandler(service.baseUrl)
  }

  Object.keys(route).forEach(function(routePath) {
    var middleware
    var _route = _formatRoutePath(routePath)
    if (service.isRemote()) {
      //we don't need to handle middleware for this case as it's transparent to balancer
      var r = route[routePath]
      // use the args from remote
      _route.args = r.args
      // set the proxy handler
      _route.handler = proxyHandler
    } else {
      var routeHandler = route[routePath]

      if (isArray(routeHandler)) {
        middleware = routeHandler
        routeHandler = middleware.pop()
      }

      if (typeof routeHandler === 'string') {
        routeHandler = service[routeHandler]
      }

      _route.args = getFnArgs(routeHandler)
      _route.handler = routeHandler
      _route.middleware = middleware || null
    }

    _routes[routePath] = _route
  })

  return _routes
}

/**
 * Process and attach internal routes, asset handlers and middlewares to the web framework.
 *
 * @return {Router} Instance of Router.
 */
Router.prototype.buildRoutes = function() {
  var router = this
  var _routes = this.getRoutes()
  var service = this.service
  var framework = this.framework

  // build routes for http endpoints
  if (_routes) {
    Object.keys(_routes).forEach(function(routeName) {
      framework.attachRoute(_routes[routeName], router, service)
    })
  }

  // serve static assets if any
  if (service.asset) {
    framework.serveAsset(service.asset, router, service)
  }

  // handle upgrade requests (websockets)
  var upgradeUrl = service.allowUpgrade()
  if (upgradeUrl && service.isRemote()) {
    var upgradeHandler = this.getUpgradeHandler()
    framework.allowUpgrade(upgradeUrl, upgradeHandler, router, service)
  }

  // build routes for http middleware endpoints
  if (service.middleware) {
    var middleware = service.middleware
    var _middlewares = {}
    Object.keys(middleware).forEach(function(name) {
      _middlewares[name] = {
        name: name,
        path: path.join(service.baseUrl, '/middleware/', name),
        handler: middleware[name]
      }
      framework.attachMiddleware(_middlewares[name], router, service)
    })
    this._middlewares = _middlewares
  }

  return this
}

/**
 * Get a function which proxy the requests to the real services.
 *
 * @param  {String} baseUrl      The base url for the target endpoint of the service.
 * @param  {String} allowUpgrade The url for upgrade request (websockets).
 * @return {Function}            The proxy handler function.
 */
Router.prototype.getProxyHandler = function(baseUrl, allowUpgrade) {
  baseUrl = baseUrl || '/'
  var proxy = httpProxy.createProxyServer()

  proxy.on('error', function(err, req, res) {
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    })

    console.error('proxy error', err)

    res.end('Proxy error')
  })

  var service = this.service

  if (allowUpgrade) {
    baseUrl = allowUpgrade
    var re = new RegExp('^' + baseUrl)
    service.on('server', function(server) {
      server.on('upgrade', function(req, socket, head) {
        if (re.test(req.url)) {
          service.scheduleProvider(function(provider) {
            var target = 'http://' + provider.address + ':' + provider.webPort
            proxy.ws(req, socket, head, {
              target: target
            })
          })
        }
      })
    })
  }

  return function(req, res) {
    service.scheduleProvider(function(provider) {
      var target = 'http://' + provider.address + ':' + provider.webPort + baseUrl
      proxy.web(req, res, {
        target: target
      })
    })
  }
}

/**
 * Get a handler for upgrade requests.
 *
 * @param  {String} upgradeUrl    The url which allows upgrade requests.
 * @return {Function}             The proxy handler function.
 */
Router.prototype.getUpgradeHandler = function(upgradeUrl) {
  var handler = this.getProxyHandler(this.service.baseUrl, upgradeUrl)
  return handler
}


/**
 * MicroMonoRouter private functions.
 */

/**
 * [formatRoutePath description]
 * @param  {[type]} routePath [description]
 * @return {Object}           Route definition object
 */
function _formatRoutePath(routePath) {
  var _route = {}
  if (typeof routePath === 'string') {
    var _path = routePath.split('::')
    var method = 'get'
    if (_path.length === 2) {
      method = _path[0]
      _path = _path[1]
    } else {
      _path = routePath
    }
    _route = {
      name: routePath,
      method: method,
      path: _path
    }
  }
  return _route
}