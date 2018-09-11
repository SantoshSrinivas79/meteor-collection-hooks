/* global Package Meteor Mongo LocalCollection CollectionHooks _ EJSON */
/* eslint-disable no-proto, no-native-reassign, no-global-assign */

// Relevant AOP terminology:
// Aspect: User code that runs before/after (hook)
// Advice: Wrapper code that knows when to call user code (aspects)
// Pointcut: before/after
var isFunction = require('lodash/isFunction')
var toArray = require('lodash/toArray')
var omit = require('lodash/omit')


var advices = {}
var Tracker = (Package.tracker && Package.tracker.Tracker) || Package.deps.Deps
var publishUserId = Meteor.isServer && new Meteor.EnvironmentVariable()

CollectionHooks = {
  defaults: {
    before: {insert: {}, update: {}, remove: {}, upsert: {}, find: {}, findOne: {}, all: {}},
    after: {insert: {}, update: {}, remove: {}, find: {}, findOne: {}, all: {}},
    all: {insert: {}, update: {}, remove: {}, find: {}, findOne: {}, all: {}}
  },
  directEnv: new Meteor.EnvironmentVariable(),
  directOp: function directOp (func) {
    return this.directEnv.withValue(true, func)
  },
  hookedOp: function hookedOp (func) {
    return this.directEnv.withValue(false, func)
  }
}

CollectionHooks.getUserId = function getUserId () {
  var userId

  if (Meteor.isClient) {
    Tracker.nonreactive(function () {
      userId = Meteor.userId && Meteor.userId()
    })
  }

  if (Meteor.isServer) {
    try {
      // Will throw an error unless within method call.
      // Attempt to recover gracefully by catching:
      userId = Meteor.userId && Meteor.userId()
    } catch (e) {}

    if (userId == null) {
      // Get the userId if we are in a publish function.
      userId = publishUserId.get()
    }
  }

  if (userId == null) {
    userId = CollectionHooks.defaultUserId
  }

  return userId
}

CollectionHooks.extendCollectionInstance = function extendCollectionInstance (self, constructor) {
  // Offer a public API to allow the user to define aspects
  // Example: collection.before.insert(func);
  ['before', 'after'].forEach(function (pointcut) {
    Object.values(advices).forEach(function (advice, method) {
      if (advice === 'upsert' && pointcut === 'after') return

      Meteor._ensure(self, pointcut, method)
      Meteor._ensure(self, '_hookAspects', method)

      self._hookAspects[method][pointcut] = []
      self[pointcut][method] = function (aspect, options) {
        var len = self._hookAspects[method][pointcut].push({
          aspect: aspect,
          options: CollectionHooks.initOptions(options, pointcut, method)
        })

        return {
          replace: function (aspect, options) {
            self._hookAspects[method][pointcut].splice(len - 1, 1, {
              aspect: aspect,
              options: CollectionHooks.initOptions(options, pointcut, method)
            })
          },
          remove: function () {
            self._hookAspects[method][pointcut].splice(len - 1, 1)
          }
        }
      }
    })
  })

  // Offer a publicly accessible object to allow the user to define
  // collection-wide hook options.
  // Example: collection.hookOptions.after.update = {fetchPrevious: false};
  self.hookOptions = EJSON.clone(CollectionHooks.defaults)

  // Wrap mutator methods, letting the defined advice do the work
  Object.values(advices).forEach(function (advice, method) {
    var collection = Meteor.isClient || method === 'upsert' ? self : self._collection

    // Store a reference to the original mutator method
    var _super = collection[method]

    Meteor._ensure(self, 'direct', method)
    self.direct[method] = function () {
      var args = arguments
      return CollectionHooks.directOp(function () {
        return constructor.prototype[method].apply(self, args)
      })
    }

    collection[method] = function () {
      if (CollectionHooks.directEnv.get() === true) {
        return _super.apply(collection, arguments)
      }

      // NOTE: should we decide to force `update` with `{upsert:true}` to use
      // the `upsert` hooks, this is what will accomplish it. It's important to
      // realize that Meteor won't distinguish between an `update` and an
      // `insert` though, so we'll end up with `after.update` getting called
      // even on an `insert`. That's why we've chosen to disable this for now.
      // if (method === "update" && _.isObject(arguments[2]) && arguments[2].upsert) {
      //   method = "upsert";
      //   advice = CollectionHooks.getAdvice(method);
      // }

      return advice.call(this,
        CollectionHooks.getUserId(),
        _super,
        self,
        method === 'upsert' ? {
          insert: self._hookAspects.insert || {},
          update: self._hookAspects.update || {},
          upsert: self._hookAspects.upsert || {}
        } : self._hookAspects[method] || {},
        function (doc) {
          return (
            isFunction(self._transform)
            ? function (d) { return self._transform(d || doc) }
            : function (d) { return d || doc }
          )
        },
        toArray(arguments),
        false
      )
    }
  })
}

CollectionHooks.defineAdvice = function defineAdvice (method, advice) {
  advices[method] = advice
}

CollectionHooks.getAdvice = function getAdvice (method) {
  return advices[method]
}

CollectionHooks.initOptions = function initOptions (options, pointcut, method) {
  return CollectionHooks.extendOptions(CollectionHooks.defaults, options, pointcut, method)
}

CollectionHooks.extendOptions = function extendOptions (source, options, pointcut, method) {
  return {...options, ...source.all.all, ...source[pointcut].all, ...source.all[method], ...source[pointcut][method]}
}

CollectionHooks.getDocs = function getDocs (collection, selector, options) {
  var findOptions = {transform: null, reactive: false} // added reactive: false

  /*
  // No "fetch" support at this time.
  if (!this._validators.fetchAllFields) {
    findOptions.fields = {};
    _.each(this._validators.fetch, function(fieldName) {
      findOptions.fields[fieldName] = 1;
    });
  }
  */

  // Bit of a magic condition here... only "update" passes options, so this is
  // only relevant to when update calls getDocs:
  if (options) {
    // This was added because in our case, we are potentially iterating over
    // multiple docs. If multi isn't enabled, force a limit (almost like
    // findOne), as the default for update without multi enabled is to affect
    // only the first matched document:
    if (!options.multi) {
      findOptions.limit = 1
    }

   findOptions = {...findOptions, ...omit(options, 'multi', 'upsert')}
  }

  // Unlike validators, we iterate over multiple docs, so use
  // find instead of findOne:
  return collection.find(selector, findOptions)
}

// This function contains a snippet of code pulled and modified from:
// ~/.meteor/packages/mongo-livedata/collection.js
// It's contained in these utility functions to make updates easier for us in
// case this code changes.
CollectionHooks.getFields = function getFields (mutator) {
  // compute modified fields
  var fields = []
  // ====ADDED START=======================
  var operators = [
    '$addToSet',
    '$bit',
    '$currentDate',
    '$inc',
    '$max',
    '$min',
    '$pop',
    '$pull',
    '$pullAll',
    '$push',
    '$rename',
    '$set',
    '$unset'
  ]
  // ====ADDED END=========================

  mutator.forEach(function (params, op) {
    // ====ADDED START=======================
    if (operators.includes(op)) {
    // ====ADDED END=========================
      Object.keys(params).forEach(function (field) {
        // treat dotted fields as if they are replacing their
        // top-level part
        if (field.indexOf('.') !== -1) {
          field = field.substring(0, field.indexOf('.'))
        }

        // record the field we are trying to change
        if (!fields.includes(field)) {
          fields.push(field)
        }
      })
      // ====ADDED START=======================
    } else {
      fields.push(op)
    }
    // ====ADDED END=========================
  })

  return fields
}

CollectionHooks.reassignPrototype = function reassignPrototype (instance, constr) {
  var hasSetPrototypeOf = typeof Object.setPrototypeOf === 'function'

  if (!constr) constr = typeof Mongo !== 'undefined' ? Mongo.Collection : Meteor.Collection

  // __proto__ is not available in < IE11
  // Note: Assigning a prototype dynamically has performance implications
  if (hasSetPrototypeOf) {
    Object.setPrototypeOf(instance, constr.prototype)
  } else if (instance.__proto__) {
    instance.__proto__ = constr.prototype
  }
}

CollectionHooks.wrapCollection = function wrapCollection (ns, as) {
  if (!as._CollectionConstructor) as._CollectionConstructor = as.Collection
  if (!as._CollectionPrototype) as._CollectionPrototype = new as.Collection(null)

  var constructor = as._CollectionConstructor
  var proto = as._CollectionPrototype

  ns.Collection = function () {
    var ret = constructor.apply(this, arguments)
    CollectionHooks.extendCollectionInstance(this, constructor)
    return ret
  }

  ns.Collection.prototype = proto
  ns.Collection.prototype.constructor = ns.Collection

  for (var prop in constructor) {
    if (constructor.hasOwnProperty(prop)) {
      ns.Collection[prop] = constructor[prop]
    }
  }
}

CollectionHooks.modify = LocalCollection._modify

if (typeof Mongo !== 'undefined') {
  CollectionHooks.wrapCollection(Meteor, Mongo)
  CollectionHooks.wrapCollection(Mongo, Mongo)
} else {
  CollectionHooks.wrapCollection(Meteor, Meteor)
}

if (Meteor.isServer) {
  var _publish = Meteor.publish
  Meteor.publish = function (name, handler, options) {
    return _publish.call(this, name, function () {
      // This function is called repeatedly in publications
      var ctx = this
      var args = arguments
      return publishUserId.withValue(ctx && ctx.userId, function () {
        return handler.apply(ctx, args)
      })
    }, options)
  }

  // Make the above available for packages with hooks that want to determine
  // whether they are running inside a publish function or not.
  CollectionHooks.isWithinPublish = function isWithinPublish () {
    return publishUserId.get() !== undefined
  }
}
