var async = require('async');
var mongodb = require('mongodb');
var DB = require('sharedb').DB;

module.exports = ShareDbMongo;

function ShareDbMongo(mongo, options) {
  // use without new
  if (!(this instanceof ShareDbMongo)) {
    return new ShareDbMongo(mongo, options);
  }

  if (typeof mongo === 'object') {
    options = mongo;
    mongo = options.mongo;
  }
  if (!options) options = {};

  // pollDelay is a dodgy hack to work around race conditions replicating the
  // data out to the polling target secondaries. If a separate db is specified
  // for polling, it defaults to 300ms
  this.pollDelay = (options.pollDelay != null) ? options.pollDelay :
    (options.mongoPoll) ? 300 : 0;

  // By default, we create indexes on any ops collection that is used
  this.disableIndexCreation = options.disableIndexCreation || false;

  // The getOps() method depends on a separate operations collection, and that
  // collection should have an index on the operations stored there. We could
  // ask people to make these indexes themselves, but by default the mongo
  // driver will do it automatically. This approach will leak memory relative
  // to the number of collections you have. This should be OK, as we are not
  // expecting thousands of mongo collections.

  // Map from collection name -> true for op collections we've ensureIndex'ed
  this.opIndexes = {};

  // Allow $while and $mapReduce queries. These queries let you run arbitrary
  // JS on the server. If users make these queries from the browser, there's
  // security issues.
  this.allowJSQueries = options.allowAllQueries || options.allowJSQueries || false;

  // Aggregate queries are less dangerous, but you can use them to access any
  // data in the mongo database.
  this.allowAggregateQueries = options.allowAllQueries || options.allowAggregateQueries || false;

  // Track whether the close method has been called
  this.closed = false;

  if (typeof mongo === 'string' || typeof mongo === 'function') {
    // We can only get the mongodb client instance in a callback, so
    // buffer up any requests received in the meantime
    this.mongo = null;
    this.mongoPoll = null;
    this.pendingConnect = [];
    this._connect(mongo, options);
  } else {
    throw new Error('deprecated: pass mongo as url string or function with callback');
  }
};

ShareDbMongo.prototype = Object.create(DB.prototype);

ShareDbMongo.prototype.projectsSnapshots = true;

ShareDbMongo.prototype.getCollection = function(collectionName, callback) {
  // Check the collection name
  var err = this.validateCollectionName(collectionName);
  if (err) return callback(err);
  // Gotcha: calls back sync if connected or async if not
  this.getDbs(function(err, mongo) {
    if (err) return callback(err);
    var collection = mongo.collection(collectionName);
    return callback(null, collection);
  });
};

ShareDbMongo.prototype._getCollectionPoll = function(collectionName, callback) {
  // Check the collection name
  var err = this.validateCollectionName(collectionName);
  if (err) return callback(err);
  // Gotcha: calls back sync if connected or async if not
  this.getDbs(function(err, mongo, mongoPoll) {
    if (err) return callback(err);
    var collection = (mongoPoll || mongo).collection(collectionName);
    return callback(null, collection);
  });
};

ShareDbMongo.prototype.getCollectionPoll = function(collectionName, callback) {
  if (this.pollDelay) {
    var self = this;
    setTimeout(function() {
      self._getCollectionPoll(collectionName, callback);
    }, this.pollDelay);
    return;
  }
  this._getCollectionPoll(collectionName, callback);
};

ShareDbMongo.prototype.getDbs = function(callback) {
  if (this.closed) {
    return callback(this.alreadyClosedError());
  }
  // We consider ouself ready to reply if this.mongo is defined and don't check
  // this.mongoPoll, since it is optional and is null by default. Thus, it's
  // important that these two properties are only set together synchronously
  if (this.mongo) return callback(null, this.mongo, this.mongoPoll);
  this.pendingConnect.push(callback);
};

ShareDbMongo.prototype._flushPendingConnect = function() {
  var pendingConnect = this.pendingConnect;
  this.pendingConnect = null;
  for (var i = 0; i < pendingConnect.length; i++) {
    pendingConnect[i](null, this.mongo, this.mongoPoll);
  }
};

ShareDbMongo.prototype._connect = function(mongo, options) {
  // Create the mongo connection client connections if needed
  //
  // Throw errors in this function if we fail to connect, since we aren't
  // implementing a way to retry
  var self = this;
  if (options.mongoPoll) {
    var tasks;
    if (typeof mongo === 'function') {
      tasks = {mongo: mongo, mongoPoll: options.mongoPoll};
    } else {
      tasks = {
        mongo: function(parallelCb) {
          mongodb.connect(mongo, options.mongoOptions, parallelCb);
        },
        mongoPoll: function(parallelCb) {
          mongodb.connect(options.mongoPoll, options.mongoPollOptions, parallelCb);
        }
      };
    }
    async.parallel(tasks, function(err, results) {
      if (err) throw err;
      self.mongo = results.mongo;
      self.mongoPoll = results.mongoPoll;
      self._flushPendingConnect();
    });
    return;
  }
  var finish = function(err, db) {
    if (err) throw err;
    self.mongo = db;
    self._flushPendingConnect();
  };
  if (typeof mongo === 'function') {
    mongo(finish);
    return;
  }
  mongodb.connect(mongo, options, finish);
};

ShareDbMongo.prototype.close = function(callback) {
  if (!callback) {
    callback = function(err) {
      if (err) throw err;
    };
  }
  var self = this;
  this.getDbs(function(err, mongo, mongoPoll) {
    if (err) return callback(err);
    self.closed = true;
    mongo.close(function(err) {
      if (err) return callback(err);
      if (!mongoPoll) return callback();
      mongoPoll.close(callback);
    });
  });
};


// **** Commit methods

ShareDbMongo.prototype.commit = function(collectionName, id, op, snapshot, callback) {
  var self = this;
  this._writeOp(collectionName, id, op, snapshot, function(err, result) {
    if (err) return callback(err);
    var opId = result.insertedId;
    self._writeSnapshot(collectionName, id, snapshot, opId, function(err, succeeded) {
      if (succeeded) return callback(err, succeeded);
      // Cleanup unsuccessful op if snapshot write failed. This is not
      // neccessary for data correctness, but it gets rid of clutter
      self._deleteOp(collectionName, opId, function(removeErr) {
        callback(err || removeErr, succeeded);
      });
    });
  });
};

ShareDbMongo.prototype._writeOp = function(collectionName, id, op, snapshot, callback) {
  if (typeof op.v !== 'number') {
    return callback(this.invalidOpVersionError(collectionName, id, op.v));
  }
  this.getOpCollection(collectionName, function(err, opCollection) {
    if (err) return callback(err);
    var doc = shallowClone(op);
    doc.d = id;
    doc.o = snapshot._opLink;
    opCollection.insertOne(doc, callback);
  });
};

ShareDbMongo.prototype._deleteOp = function(collectionName, opId, callback) {
  this.getOpCollection(collectionName, function(err, opCollection) {
    if (err) return callback(err);
    opCollection.deleteOne({_id: opId}, callback);
  });
};

ShareDbMongo.prototype._writeSnapshot = function(collectionName, id, snapshot, opLink, callback) {
  this.getCollection(collectionName, function(err, collection) {
    if (err) return callback(err);
    var doc = castToDoc(id, snapshot, opLink);
    if (doc._v === 1) {
      collection.insertOne(doc, function(err, result) {
        if (err) {
          // Return non-success instead of duplicate key error, since this is
          // expected to occur during simultaneous creates on the same id
          if (err.code === 11000) return callback(null, false);
          return callback(err);
        }
        callback(null, true);
      });
    } else {
      collection.replaceOne({_id: id, _v: doc._v - 1}, doc, function(err, result) {
        if (err) return callback(err);
        var succeeded = !!result.modifiedCount;
        callback(null, succeeded);
      });
    }
  });
};


// **** Snapshot methods

ShareDbMongo.prototype.getSnapshot = function(collectionName, id, fields, callback) {
  this.getCollection(collectionName, function(err, collection) {
    if (err) return callback(err);
    var query = {_id: id};
    var projection = getProjection(fields);
    collection.find(query).limit(1).project(projection).next(function(err, doc) {
      if (err) return callback(err);
      var snapshot = (doc) ? castToSnapshot(doc) : new MongoSnapshot(id, 0, null, undefined);
      callback(null, snapshot);
    });
  });
};

ShareDbMongo.prototype.getSnapshotBulk = function(collectionName, ids, fields, callback) {
  this.getCollection(collectionName, function(err, collection) {
    if (err) return callback(err);
    var query = {_id: {$in: ids}};
    var projection = getProjection(fields);
    collection.find(query).project(projection).toArray(function(err, docs) {
      if (err) return callback(err);
      var snapshotMap = {};
      for (var i = 0; i < docs.length; i++) {
        var snapshot = castToSnapshot(docs[i]);
        snapshotMap[snapshot.id] = snapshot;
      }
      var uncreated = [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (snapshotMap[id]) continue;
        snapshotMap[id] = new MongoSnapshot(id, 0, null, undefined);
      }
      callback(null, snapshotMap);
    });
  });
};


// **** Oplog methods

// Overwrite me if you want to change this behaviour.
ShareDbMongo.prototype.getOplogCollectionName = function(collectionName) {
  return 'o_' + collectionName;
};

ShareDbMongo.prototype.validateCollectionName = function(collectionName) {
  if (
    collectionName === 'system' || (
      collectionName[0] === 'o' &&
      collectionName[1] === '_'
    )
  ) {
    return this.invalidCollectionError(collectionName);
  }
};

// Get and return the op collection from mongo, ensuring it has the op index.
ShareDbMongo.prototype.getOpCollection = function(collectionName, callback) {
  var self = this;
  this.getDbs(function(err, mongo) {
    if (err) return callback(err);
    var name = self.getOplogCollectionName(collectionName);
    var collection = mongo.collection(name);
    // Given the potential problems with creating indexes on the fly, it might
    // be preferrable to disable automatic creation
    if (self.disableIndexCreation) {
      return callback(null, collection);
    }
    if (self.opIndexes[collectionName]) {
      return callback(null, collection);
    }
    // WARNING: Creating indexes automatically like this is quite dangerous in
    // production if we are starting with a lot of data and no indexes
    // already. If new indexes were added or definition of these indexes were
    // changed, users upgrading this module could unsuspectingly lock up their
    // databases. If indexes are created as the first ops are added to a
    // collection this won't be a problem, but this is a dangerous mechanism.
    // Perhaps we should only warn instead of creating the indexes, especially
    // when there is a lot of data in the collection.
    collection.createIndex({d: 1, v: 1}, {background: true}, function(err) {
      if (err) return callback(err);
      collection.createIndex({src: 1, seq: 1, v: 1}, {background: true}, function(err) {
        if (err) return callback(err);
        self.opIndexes[collectionName] = true;
        callback(null, collection);
      });
    });
  });
};

ShareDbMongo.prototype.getOpsToSnapshot = function(collectionName, id, from, snapshot, callback) {
  if (snapshot._opLink == null) {
    var err = getSnapshotOpLinkErorr(collectionName, id);
    return callback(err);
  }
  this._getOps(collectionName, id, from, function(err, ops) {
    if (err) return callback(err);
    var filtered = getLinkedOps(ops, null, snapshot._opLink);
    var err = checkOpsFrom(collectionName, id, filtered, from);
    if (err) return callback(err);
    callback(null, filtered);
  });
};

ShareDbMongo.prototype.getOps = function(collectionName, id, from, to, callback) {
  var self = this;
  this._getSnapshotOpLink(collectionName, id, function(err, doc) {
    if (err) return callback(err);
    if (doc) {
      if (isCurrentVersion(doc, from)) {
        return callback(null, []);
      }
      var err = doc && checkDocHasOp(collectionName, id, doc);
      if (err) return callback(err);
    }
    self._getOps(collectionName, id, from, function(err, ops) {
      if (err) return callback(err);
      var filtered = filterOps(ops, doc, to);
      var err = checkOpsFrom(collectionName, id, filtered, from);
      if (err) return callback(err);
      callback(null, filtered);
    });
  });
};

ShareDbMongo.prototype.getOpsBulk = function(collectionName, fromMap, toMap, callback) {
  var self = this;
  var ids = Object.keys(fromMap);
  this._getSnapshotOpLinkBulk(collectionName, ids, function(err, docs) {
    if (err) return callback(err);
    var docMap = getDocMap(docs);
    // Add empty array for snapshot versions that are up to date and create
    // the query conditions for ops that we need to get
    var conditions = [];
    var opsMap = {};
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var doc = docMap[id];
      var from = fromMap[id];
      if (doc) {
        if (isCurrentVersion(doc, from)) {
          opsMap[id] = [];
          continue;
        }
        var err = checkDocHasOp(collectionName, id, doc);
        if (err) return callback(err);
      }
      var condition = getOpsQuery(id, from);
      conditions.push(condition);
    }
    // Return right away if none of the snapshot versions are newer than the
    // requested versions
    if (!conditions.length) return callback(null, opsMap);
    // Otherwise, get all of the ops that are newer
    self._getOpsBulk(collectionName, conditions, function(err, opsBulk) {
      if (err) return callback(err);
      for (var i = 0; i < conditions.length; i++) {
        var id = conditions[i].d;
        var ops = opsBulk[id];
        var doc = docMap[id];
        var from = fromMap[id];
        var to = toMap && toMap[id];
        var filtered = filterOps(ops, doc, to);
        var err = checkOpsFrom(collectionName, id, filtered, from);
        if (err) return callback(err);
        opsMap[id] = filtered;
      }
      callback(null, opsMap);
    });
  });
};

DB.prototype.getCommittedOpVersion = function(collectionName, id, snapshot, op, callback) {
  var self = this;
  this.getOpCollection(collectionName, function(err, opCollection) {
    if (err) return callback(err);
    var query = {
      src: op.src,
      seq: op.seq
    };
    var projection = {v: 1, _id: 0};
    var sort = {v: 1};
    // Find the earliest version at which the op may have been committed.
    // Since ops are optimistically written prior to writing the snapshot, the
    // op could end up being written multiple times or have been written but
    // not count as committed if not backreferenced from the snapshot
    opCollection.find(query).project(projection).sort(sort).limit(1).next(function(err, doc) {
      if (err) return callback(err);
      // If we find no op with the same src and seq, we definitely don't have
      // any match. This should prevent us from accidentally querying a huge
      // history of ops
      if (!doc) return callback();
      // If we do find an op with the same src and seq, we still have to get
      // the ops from the snapshot to figure out if the op was actually
      // committed already, and at what version in case of multiple matches
      var from = doc.v;
      self.getOpsToSnapshot(collectionName, id, from, snapshot, function(err, ops) {
        if (err) return callback(err);
        for (var i = ops.length; i--;) {
          var item = ops[i];
          if (op.src === item.src && op.seq === item.seq) {
            return callback(null, item.v);
          }
        }
        callback();
      });
    });
  });
};

function checkOpsFrom(collectionName, id, ops, from) {
  if (ops.length === 0) return;
  if (ops[0] && ops[0].v === from) return;
  if (from == null) return;
  return ShareDbMongo.prototype.missingOpsError(collectionName, id, from);
};

function getSnapshotOpLinkErorr(collectionName, id) {
  return this.missingLastOperationError(collectionName, id);
}

function checkDocHasOp(collectionName, id, doc) {
  if (doc._o) return;
  return getSnapshotOpLinkErorr(collectionName, id);
}

function isCurrentVersion(doc, version) {
  return doc._v === version;
}

function getDocMap(docs) {
  var docMap = {};
  for (var i = 0; i < docs.length; i++) {
    var doc = docs[i];
    docMap[doc._id] = doc;
  }
  return docMap;
}

function filterOps(ops, doc, to) {
  // Always return in the case of no ops found whether or not consistent with
  // the snapshot
  if (!ops) return [];
  if (!ops.length) return ops;
  if (!doc) {
    // There is no snapshot currently. We already returned if there are no
    // ops, so this could happen if:
    //   1. The doc was deleted
    //   2. The doc create op is written but not the doc snapshot
    //   3. Same as 3 for a recreate
    //   4. We are in an inconsistent state because of an error
    //
    // We treat the snapshot as the canonical version, so if the snapshot
    // doesn't exist, the doc should be considered deleted. Thus, a delete op
    // should be in the last version if no commits are inflight or second to
    // last version if commit(s) are inflight. Rather than trying to detect
    // ops inconsistent with a deleted state, we are simply returning ops from
    // the last delete. Inconsistent states will ultimately cause write
    // failures on attempt to commit.
    //
    // Different delete ops must be identical and must link back to the same
    // prior version in order to be inserted, so if there are multiple delete
    // ops at the same version, we can grab any of them for this method.
    // However, the _id of the delete op might not ultimately match the delete
    // op that gets maintained if two are written as a result of two
    // simultanous delete commits. Thus, the _id of the op should *not* be
    // assumed to be consistent in the future.
    var deleteOp = getLatestDeleteOp(ops);
    // Don't return any ops if we don't find a delete operation, which is the
    // correct thing to do if the doc was just created and the op has been
    // written but not the snapshot. Note that this will simply return no ops
    // if there are ops but the snapshot doesn't exist.
    if (!deleteOp) return [];
    return getLinkedOps(ops, to, deleteOp._id);
  }
  return getLinkedOps(ops, to, doc._o);
}

function getLatestDeleteOp(ops) {
  for (var i = ops.length; i--;) {
    var op = ops[i];
    if (op.del) return op;
  }
}

function getLinkedOps(ops, to, link) {
  var linkedOps = []
  for (var i = ops.length; i-- && link;) {
    var op = ops[i];
    if (link.equals ? !link.equals(op._id) : link !== op._id) continue;
    link = op.o;
    if (to == null || op.v < to) {
      delete op._id;
      delete op.o;
      linkedOps.unshift(op);
    }
  }
  return linkedOps;
}

function getOpsQuery(id, from) {
  return (from == null) ?
    {d: id} :
    {d: id, v: {$gte: from}};
}

ShareDbMongo.prototype._getOps = function(collectionName, id, from, callback) {
  this.getOpCollection(collectionName, function(err, opCollection) {
    if (err) return callback(err);
    var query = getOpsQuery(id, from);
    // Exclude the `d` field, which is only for use internal to livedb-mongo.
    // Also exclude the `m` field, which can be used to store metadata on ops
    // for tracking purposes
    var projection = {d: 0, m: 0};
    var sort = {v: 1};
    opCollection.find(query).project(projection).sort(sort).toArray(callback);
  });
};

ShareDbMongo.prototype._getOpsBulk = function(collectionName, conditions, callback) {
  this.getOpCollection(collectionName, function(err, opCollection) {
    if (err) return callback(err);
    var query = {$or: conditions};
    // Exclude the `m` field, which can be used to store metadata on ops for
    // tracking purposes
    var projection = {m: 0};
    var stream = opCollection.find(query).project(projection).stream();
    readOpsBulk(stream, callback);
  });
};

function readOpsBulk(stream, callback) {
  var opsMap = {};
  var errored;
  stream.on('error', function(err) {
    errored = true;
    return callback(err);
  });
  stream.on('end', function() {
    if (errored) return;
    // Sort ops for each doc in ascending order by version
    for (var id in opsMap) {
      opsMap[id].sort(function(a, b) {
        return a.v - b.v;
      });
    }
    callback(null, opsMap);
  });
  // Read each op and push onto a list for the appropriate doc
  stream.on('data', function(op) {
    var id = op.d;
    if (opsMap[id]) {
      opsMap[id].push(op);
    } else {
      opsMap[id] = [op];
    }
    delete op.d;
  });
}

ShareDbMongo.prototype._getSnapshotOpLink = function(collectionName, id, callback) {
  this.getCollection(collectionName, function(err, collection) {
    if (err) return callback(err);
    var query = {_id: id};
    var projection = {_id: 0, _o: 1, _v: 1};
    collection.find(query).limit(1).project(projection).next(callback);
  });
};

ShareDbMongo.prototype._getSnapshotOpLinkBulk = function(collectionName, ids, callback) {
  this.getCollection(collectionName, function(err, collection) {
    if (err) return callback(err);
    var query = {_id: {$in: ids}};
    var projection = {_o: 1, _v: 1};
    collection.find(query).project(projection).toArray(callback);
  });
};


// **** Query methods

ShareDbMongo.prototype._query = function(collection, inputQuery, projection, callback) {
  var parsed = this._getSafeParsedQuery(inputQuery, callback);
  if (!parsed) return;

  // Collection operations such as $aggregate run on the whole
  // collection. Only one operation is run. The result goes in the
  // "extra" argument in the callback.
  if (parsed.collectionOperationKey) {
    collectionOperationsMap[parsed.collectionOperationKey](
      collection,
      parsed.query,
      parsed.collectionOperationValue,
      function(err, extra) {
        if (err) return callback(err);
        callback(null, [], extra);
      }
    );
    return;
  }

  // No collection operations were used. Create an initial cursor for
  // the query, that can be transformed later.
  var cursor = collection.find(parsed.query).project(projection);

  // Cursor transforms such as $skip transform the cursor into a new
  // one. If multiple transforms are specified on inputQuery, they all
  // run.
  for (var key in parsed.cursorTransforms) {
    var transform = cursorTransformsMap[key];
    cursor = transform(cursor, parsed.cursorTransforms[key]);
    if (!cursor) {
      return callback(this.malformedQueryOperatorError(key));
    }
  }

  // Cursor operations such as $count run on the cursor, after all
  // transforms. Only one operation is run. The result goes in the
  // "extra" argument in the callback.
  if (parsed.cursorOperationKey) {
    cursorOperationsMap[parsed.cursorOperationKey](
      cursor,
      parsed.cursorOperationValue,
      function(err, extra) {
        if (err) return callback(err);
        callback(null, [], extra);
      }
    );
    return;
  }

  // If no collection operation or cursor operations were used, return
  // an array of snapshots that are passed in the "results" argument
  // in the callback
  cursor.toArray(callback);
};

ShareDbMongo.prototype.query = function(collectionName, inputQuery, fields, options, callback) {
  var self = this;
  this.getCollection(collectionName, function(err, collection) {
    if (err) return callback(err);
    var projection = getProjection(fields);
    self._query(collection, inputQuery, projection, function(err, results, extra) {
      if (err) return callback(err);
      var snapshots = [];
      for (var i = 0; i < results.length; i++) {
        var snapshot = castToSnapshot(results[i]);
        snapshots.push(snapshot);
      }
      callback(null, snapshots, extra);
    });
  });
};

ShareDbMongo.prototype.queryPoll = function(collectionName, inputQuery, options, callback) {
  var self = this;
  this.getCollectionPoll(collectionName, function(err, collection) {
    if (err) return callback(err);
    var projection = {_id: 1};
    self._query(collection, inputQuery, projection, function(err, results, extra) {
      if (err) return callback(err);
      var ids = [];
      for (var i = 0; i < results.length; i++) {
        ids.push(results[i]._id);
      }
      callback(null, ids, extra);
    });
  });
};

ShareDbMongo.prototype.queryPollDoc = function(collectionName, id, inputQuery, options, callback) {
  var self = this;
  self.getCollectionPoll(collectionName, function(err, collection) {
    var parsed = self._getSafeParsedQuery(inputQuery, callback);
    if (!parsed) return;

    // Run the query against a particular mongo document by adding an _id filter
    var queryId = parsed.query._id;
    if (queryId && typeof queryId === 'object') {
      // Check if the query contains the id directly in the common pattern of
      // a query for a specific list of ids, such as {_id: {$in: [1, 2, 3]}}
      if (Array.isArray(queryId.$in) && Object.keys(queryId).length === 1) {
        if (queryId.$in.indexOf(id) === -1) {
          // If the id isn't in the list of ids, then there is no way this
          // can be a match
          return callback(null, false);
        } else {
          // If the id is in the list, then it is equivalent to restrict to our
          // particular id and override the current value
          parsed.query._id = id;
        }
      } else {
        delete parsed.query._id;
        parsed.query.$and = (parsed.query.$and) ?
          parsed.query.$and.concat({_id: id}, {_id: queryId}) :
          [{_id: id}, {_id: queryId}];
      }
    } else if (queryId && queryId !== id) {
      // If queryId is a primative value such as a string or number and it
      // isn't equal to the id, then there is no way this can be a match
      return callback(null, false);
    } else {
      // Restrict the query to this particular document
      parsed.query._id = id;
    }

    collection.find(parsed.query).limit(1).project({_id: 1}).next(function(err, doc) {
      callback(err, !!doc);
    });
  });
};


// **** Polling optimization

// Can we poll by checking the query limited to the particular doc only?
ShareDbMongo.prototype.canPollDoc = function(collectionName, query) {
  for (var operation in collectionOperationsMap) {
    if (query.hasOwnProperty(operation)) return false;
  }
  for (var operation in cursorOperationsMap) {
    if (query.hasOwnProperty(operation)) return false;
  }

  if (
    query.hasOwnProperty('$sort') ||
    query.hasOwnProperty('$orderby') ||
    query.hasOwnProperty('$limit') ||
    query.hasOwnProperty('$skip') ||
    query.hasOwnProperty('$max') ||
    query.hasOwnProperty('$min') ||
    query.hasOwnProperty('$returnKey')
  ) {
    return false;
  }

  return true;
};

// Return true to avoid polling if there is no possibility that an op could
// affect a query's results
ShareDbMongo.prototype.skipPoll = function(collectionName, id, op, query) {
  // Livedb is in charge of doing the validation of ops, so at this point we
  // should be able to assume that the op is structured validly
  if (op.create || op.del) return false;
  if (!op.op) return true;

  // Right now, always re-poll if using a collection operation such as
  // $distinct or a cursor operation such as $count. This could be
  // optimized further in some cases.
  for (var operation in collectionOperationsMap) {
    if (query.hasOwnProperty(operation)) return false;
  }
  for (var operation in cursorOperationsMap) {
    if (query.hasOwnProperty(operation)) return false;
  }

  var fields = getFields(query);
  return !opContainsAnyField(op.op, fields);
};

function getFields(query) {
  var fields = {};
  getInnerFields(query.$orderby, fields);
  getInnerFields(query.$sort, fields);
  getInnerFields(query, fields);
  return fields;
}

function getInnerFields(params, fields) {
  if (!params) return;
  for (var key in params) {
    var value = params[key];
    if (key === '$or' || key === '$and') {
      for (var i = 0; i < value.length; i++) {
        var item = value[i];
        getInnerFields(item, fields);
      }
    } else if (key[0] !== '$') {
      var property = key.split('.')[0];
      fields[property] = true;
    }
  }
}

function opContainsAnyField(op, fields) {
  for (var i = 0; i < op.length; i++) {
    var component = op[i];
    if (component.p.length === 0) {
      return true;
    } else if (fields[component.p[0]]) {
      return true;
    }
  }
  return false;
}


// Utility methods

// Return {code: ..., message: ...}  on error. Call before parseQuery.
ShareDbMongo.prototype.checkQuery = function(query) {
  if (query.$query) {
    return this.$queryDeprecatedError();
  }

  var validMongoErr = checkValidMongo(query);
  if (validMongoErr) return validMongoErr;

  if (!this.allowJSQueries) {
    if (query.$where != null) {
      return this.$whereDisabledError();
    }
    if (query.$mapReduce != null) {
      return this.$mapReduceDisabledError();
    }
  }

  if (!this.allowAggregateQueries && query.$aggregate) {
    return this.$aggregateDisabledError();
  }
};

// Check that any keys starting with $ are valid Mongo methods. Verify
// that:
// * There is at most one collection operation like $mapReduce
// * If there is a collection operation then there are no cursor methods
// * There is at most one cursor operation like $count
//
// Return {code: ..., message: ...} on error.
function checkValidMongo(query) {
  var collectionOperationKey = null; // only one allowed
  var foundCursorMethod = false; // transform or operation
  var cursorOperationKey = null; // only one allowed

  for (var key in query) {
    if (key[0] === '$') {
      if (collectionOperationsMap[key]) {
        // Found collection operation. Check that it's unique.

        if (collectionOperationKey) {
          return ShareDbMongo.prototype.onlyOneCollectionOperationError(
            collectionOperationKey, key
          );
        }
        collectionOperationKey = key;
      } else if (cursorOperationsMap[key]) {
        if (cursorOperationKey) {
          return ShareDbMongo.prototype.onlyOneCursorOperationError(
            cursorOperationKey, key
          );
        }
        cursorOperationKey = key;
        foundCursorMethod = true;
      } else if (cursorTransformsMap[key]) {
        foundCursorMethod = true;
      }
    }
  }

  if (collectionOperationKey && foundCursorMethod) {
    return ShareDbMongo.prototype.cursorAndCollectionMethodError(
      collectionOperationKey
    );
  }

  return null;
}

function ParsedQuery(
  query,
  collectionOperationKey,
  collectionOperationValue,
  cursorTransforms,
  cursorOperationKey,
  cursorOperationValue
) {
  this.query = query;
  this.collectionOperationKey = collectionOperationKey;
  this.collectionOperationValue = collectionOperationValue;
  this.cursorTransforms = cursorTransforms;
  this.cursorOperationKey = cursorOperationKey;
  this.cursorOperationValue = cursorOperationValue;
}

// Parses a query and makes it safe against deleted docs. On error,
// call the callback and return null.
ShareDbMongo.prototype._getSafeParsedQuery = function(inputQuery, callback) {
  var err = this.checkQuery(inputQuery);
  if (err) {
    callback(err);
    return null;
  }

  try {
    var parsed = parseQuery(inputQuery);
  } catch (err) {
    callback(this.parseQueryError(err));
    return null;
  }

  makeQuerySafe(parsed);
  return parsed;
};

function parseQuery(inputQuery) {
  // Parse sharedb-mongo query format into an object with these keys:
  // * query: The actual mongo query part of the input query
  // * collectionOperationKey, collectionOperationValue: Key and value of the
  //   single collection operation (eg $mapReduce) defined in the input query,
  //   or null
  // * cursorTransforms: Map of all the cursor transforms in the input query
  //   (eg $sort)
  // * cursorOperationKey, cursorOperationValue: Key and value of the single
  //   cursor operation (eg $count) defined in the input query, or null
  //
  // Examples:
  //
  // parseQuery({foo: {$ne: 'bar'}, $distinct: {field: 'x'}}) ->
  // {
  //   query: {foo: {$ne: 'bar'}},
  //   collectionOperationKey: '$distinct',
  //   collectionOperationValue: {field: 'x'},
  //   cursorTransforms: {},
  //   cursorOperationKey: null,
  //   cursorOperationValue: null
  // }
  //
  // parseQuery({foo: 'bar', $limit: 2, $count: true}) ->
  // {
  //   query: {foo: 'bar'},
  //   collectionOperationKey: null,
  //   collectionOperationValue: null
  //   cursorTransforms: {$limit: 2},
  //   cursorOperationKey: '$count',
  //   cursorOperationValue: 2
  // }

  var query = {};
  var collectionOperationKey = null;
  var collectionOperationValue = null;
  var cursorTransforms = {};
  var cursorOperationKey = null;
  var cursorOperationValue = null;

  if (inputQuery.$query) {
    throw new Error("unexpected $query: should have called checkQuery");
  } else {
    for (var key in inputQuery) {
      if (collectionOperationsMap[key]) {
        collectionOperationKey = key;
        collectionOperationValue = inputQuery[key];
      } else if (cursorTransformsMap[key]) {
        cursorTransforms[key] = inputQuery[key];
      } else if (cursorOperationsMap[key]) {
        cursorOperationKey = key;
        cursorOperationValue = inputQuery[key];
      } else {
        query[key] = inputQuery[key];
      }
    }
  }

  return new ParsedQuery(
    query,
    collectionOperationKey,
    collectionOperationValue,
    cursorTransforms,
    cursorOperationKey,
    cursorOperationValue
  );
};
ShareDbMongo._parseQuery = parseQuery; // for tests

// Call on a query after it gets parsed to make it safe against
// matching deleted documents.
function makeQuerySafe(parsedQuery) {
  // Deleted documents are kept around so that we can start their version from
  // the last version if they get recreated. Lack of a type indicates that a
  // snapshot is deleted, so don't return any documents with a null type
  if (deletedDocCouldSatisfyQuery(parsedQuery.query)) {
    parsedQuery.query._type = {$ne: null};
  }
};
ShareDbMongo._makeQuerySafe = makeQuerySafe; // for tests

// Could a deleted doc (one that contains {_type: null} and no other
// fields) satisfy a query?
//
// Return true if it definitely can, or if we're not sure. (This
// function is used as an optimization to see whether we can avoid
// augmenting the query to ignore deleted documents)
function deletedDocCouldSatisfyQuery(query) {
  // Any query with `{foo: value}` with non-null `value` will never
  // match deleted documents (that are empty other than the `_type`
  // field).
  //
  // This generalizes to additional classes of queries. Here’s a
  // recursive description of queries that can't match a deleted doc:
  // In general, a query with `{foo: X}` can't match a deleted doc
  // if `X` is guaranteed to not match null or undefined. In addition
  // to non-null values, the following clauses are guaranteed to not
  // match null or undefined:
  //
  // * `{$in: [A, B, C]}}` where all of A, B, C are non-null.
  // * `{$ne: null}`
  // * `{$exists: true}`
  // * `{$gt: not null}`, `{gte: not null}`, `{$lt: not null}`, `{$lte: nou null}`
  //
  // In addition, some queries that have `$and` or `$or` at the
  // top-level can't match deleted docs:
  // * `{$and: [A, B, C]}`, where at least one of A, B, C are queries
  //   guaranteed to not match `{_type: null}`
  // * `{$or: [A, B, C]}`, where all of A, B, C are queries guaranteed
  //   to not match `{_type: null}`
  //
  // There are more queries that can't match deleted docs but they
  // aren’t that common, e.g. ones using `$type` or bit-wise
  // operators.
  if (query.hasOwnProperty('$and')) {
    if (Array.isArray(query.$and)) {
      for (var i = 0; i < query.$and.length; i++) {
        if (!deletedDocCouldSatisfyQuery(query.$and[i])) {
          return false;
        }
      }
      return true;
    } else {
      // Malformed? Play it safe.
      return true;
    }
  }

  if (query.hasOwnProperty('$or')) {
    if (Array.isArray(query.$or)) {
      for (var i = 0; i < query.$or.length; i++) {
        if (deletedDocCouldSatisfyQuery(query.$or[i])) {
          return true;
        }
      }
      return false;
    } else {
      // Malformed? Play it safe.
      return true;
    }
  }

  for (var prop in query) {
    // When using top-level operators that we don't understand, play
    // it safe
    if (prop[0] === '$') {
      return true;
    }
    if (!couldMatchNull(query[prop])) {
      return false;
    }
  }

  return true;
}

function couldMatchNull(clause) {
  if (
    typeof clause === 'number' ||
    typeof clause === 'boolean' ||
    typeof clause === 'string'
  ) {
    return false;
  } else if (clause === null) {
    return true;
  } else if (isPlainObject(clause)) {
    // Mongo interprets clauses with multiple properties with an
    // implied 'and' relationship, e.g. {$gt: 3, $lt: 6}. If every
    // part of the clause could match null then the full clause could
    // match null.
    for (var prop in clause) {
      var value = clause[prop];
      if (prop === '$in' && Array.isArray(value)) {
        var partCouldMatchNull = false;
        for (var i = 0; i < value.length; i++) {
          if (value[i] === null) {
            partCouldMatchNull = true;
            break;
          }
        }
        if (!partCouldMatchNull) {
          return false;
        }
      } else if (prop === '$ne') {
        if (value === null) {
          return false;
        }
      } else if (prop === '$exists') {
        if (value) {
          return false;
        }
      } else if (prop === '$gt' || prop === '$gte' || prop === '$lt' || prop === '$lte') {
        if (value !== null) {
          return false;
        }
      } else {
        // Not sure what to do with this part of the clause; assume it
        // could match null.
      }
    }

    // All parts of the clause could match null.
    return true;
  } else {
    // Not a POJO, string, number, or boolean. Not sure what it is,
    // but play it safe.
    return true;
  }
}

function castToDoc(id, snapshot, opLink) {
  var data = snapshot.data;
  var doc =
    (isObject(data)) ? shallowClone(data) :
    (data === undefined) ? {} :
    {_data: data};
  doc._id = id;
  doc._type = snapshot.type;
  doc._v = snapshot.v;
  doc._m = snapshot.m;
  doc._o = opLink;
  return doc;
}

function castToSnapshot(doc) {
  var id = doc._id;
  var version = doc._v;
  var type = doc._type;
  var data = doc._data;
  var meta = doc._m;
  var opLink = doc._o;
  if (type == null) {
    return new MongoSnapshot(id, version, null, undefined, meta, opLink);
  }
  if (doc.hasOwnProperty('_data')) {
    return new MongoSnapshot(id, version, type, data, meta, opLink);
  }
  data = shallowClone(doc);
  delete data._id;
  delete data._v;
  delete data._type;
  delete data._m;
  delete data._o;
  return new MongoSnapshot(id, version, type, data, meta, opLink);
}
function MongoSnapshot(id, version, type, data, meta, opLink) {
  this.id = id;
  this.v = version;
  this.type = type;
  this.data = data;
  if (meta) this.m = meta;
  if (opLink) this._opLink = opLink;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shallowClone(object) {
  var out = {};
  for (var key in object) {
    out[key] = object[key];
  }
  return out;
}

function isPlainObject(value) {
  return (
    typeof value === 'object' && (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    )
  );
}

// Convert a simple map of fields that we want into a mongo projection. This
// depends on the data being stored at the top level of the document. It will
// only work properly for json documents--which are the only types for which
// we really want projections.
function getProjection(fields) {
  // When there is no projection specified, still exclude returning the
  // metadata that is added to a doc for querying or auditing
  if (!fields) return {_m: 0, _o: 0};
  // Do not project when called by ShareDB submit
  if (fields.$submit) return;

  var projection = {};
  for (var key in fields) {
    projection[key] = 1;
  }
  projection._type = 1;
  projection._v = 1;
  return projection;
}

var collectionOperationsMap = {
  '$distinct': function(collection, query, value, cb) {
    collection.distinct(value.field, query, cb);
  },
  '$aggregate': function(collection, query, value, cb) {
    collection.aggregate(value, cb);
  },
  '$mapReduce': function(collection, query, value, cb) {
    if (typeof value !== 'object') {
      return cb(ShareDbMongo.prototype.malformedQueryOperatorError('$mapReduce'));
    }
    var mapReduceOptions = {
      query: query,
      out: {inline: 1},
      scope: value.scope || {}
    };
    collection.mapReduce(
      value.map, value.reduce, mapReduceOptions, cb);
  }
};

var cursorOperationsMap = {
  '$count': function(cursor, value, cb) {
    cursor.count(cb);
  },
  '$explain': function(cursor, verbosity, cb) {
    cursor.explain(verbosity, cb);
  },
  '$map': function(cursor, fn, cb) {
    cursor.map(fn, cb);
  }
};

var cursorTransformsMap = {
  '$batchSize': function(cursor, size) { return cursor.batchSize(size); },
  '$comment': function(cursor, text) { return cursor.comment(text); },
  '$hint': function(cursor, index) { return cursor.hint(index); },
  '$max': function(cursor, value) { return cursor.max(value); },
  '$maxScan': function(cursor, value) { return cursor.maxScan(value); },
  '$maxTimeMS': function(cursor, milliseconds) {
    return cursor.maxTimeMS(milliseconds);
  },
  '$min': function(cursor, value) { return cursor.min(value); },
  '$noCursorTimeout': function(cursor) {
    // no argument to cursor method
    return cursor.noCursorTimeout();
  },
  '$orderby': function(cursor, value) {
    console.warn('Deprecated: $orderby; Use $sort.');
    return cursor.sort(value);
  },
  '$readConcern': function(cursor, level) {
    return cursor.readConcern(level);
  },
  '$readPref': function(cursor, value) {
    // The Mongo driver cursor method takes two argments. Our queries
    // have a single value for the '$readPref' property. Interpret as
    // an object with {mode, tagSet}.
    if (typeof value !== 'object') return null;
    return cursor.readPref(value.mode, value.tagSet);
  },
  '$returnKey': function(cursor) {
    // no argument to cursor method
    return cursor.returnKey();
  },
  '$snapshot': function(cursor) {
    // no argument to cursor method
    return cursor.snapshot();
  },
  '$sort': function(cursor, value) { return cursor.sort(value); },
  '$skip': function(cursor, value) { return cursor.skip(value); },
  '$limit': function(cursor, value) { return cursor.limit(value); },
  '$showDiskLoc': function(cursor, value) {
    console.warn('Deprecated: $showDiskLoc; Use $showRecordId.');
    return cursor.showRecordId(value);
  },
  '$showRecordId': function(cursor) {
    // no argument to cursor method
    return cursor.showRecordId();
  }
};

// Bad request errors
ShareDbMongo.prototype.invalidOpVersionError = function(collectionName, id, v) {
  return {
    code: 4101,
    message: 'Invalid op version ' + collectionName + '.' + id + ' ' + op.v
  };
};
ShareDbMongo.prototype.invalidCollectionError = function(collectionName) {
  return {code: 4102, message: 'Invalid collection name ' + collectionName};
};
ShareDbMongo.prototype.$whereDisabledError = function() {
  return {code: 4103, message: '$where queries disabled'};
};
ShareDbMongo.prototype.$mapReduceDisabledError = function() {
  return {code: 4104, message: '$mapReduce queries disabled'};
};
ShareDbMongo.prototype.$aggregateDisabledError = function() {
  return {code: 4105, message: '$aggregate queries disabled'};
};
ShareDbMongo.prototype.$queryDeprecatedError = function() {
  return {code: 4106, message: '$query property deprecated in queries'};
};
ShareDbMongo.prototype.malformedQueryOperatorError = function(operator) {
  return {code: 4107, message: "Malformed query operator: " + operator};
};
ShareDbMongo.prototype.onlyOneCollectionOperationError = function(operation1, operation2) {
  return {
    code: 4108,
    message: 'Only one collection operation allowed. ' +
      'Found ' + operation1 + ' and ' + operation2
  }
};
ShareDbMongo.prototype.onlyOneCursorOperationError = function(operation1, operation2) {
  return {
    code: 4109,
    message: 'Only one cursor operation allowed. ' +
      'Found ' + operation1 + ' and ' + operation2
  }
};
ShareDbMongo.prototype.cursorAndCollectionMethodError = function(collectionOperation) {
  return {
    code: 4110,
    message: 'Cursor methods can\'t run after collection method ' +
      collectionOperation
  };
};

// Internal errors
ShareDbMongo.prototype.alreadyClosedError = function() {
  return {code: 5101, message: 'Already closed'};
};
ShareDbMongo.prototype.missingLastOperationError = function(collectionName, id) {
  return {
    code: 5102,
    message: 'Snapshot missing last operation field "_o" ' + collectionName + '.' + id
  };
};
ShareDbMongo.prototype.missingOpsError = function(collectionName, id, from) {
  return {
    code: 5103,
    message: 'Missing ops from requested version ' + collectionName + '.' + id + ' ' + from
  }
};
// Modifies 'err' argument
ShareDbMongo.prototype.parseQueryError = function(err) {
  err.code = 5104
  return err;
};