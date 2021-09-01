// Utilities for db handling
import _ from 'lodash';

import async from 'async';
import bowser from 'bowser';
import { compileDocumentSelector } from './selector';
import { compileSort } from './selector';
import { default as booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { default as intersect } from "@turf/intersect";
import { default as booleanCrosses } from "@turf/boolean-crosses";
import { default as booleanWithin } from "@turf/boolean-within";

// Test window.localStorage
const isLocalStorageSupported = function() {
  if (!window.localStorage) {
    return false;
  }
  try {
    window.localStorage.setItem("test", "test");
    window.localStorage.removeItem("test");
    return true;
  } catch (e) {
    return false;
  }
};

// Compile a document selector (query) to a lambda function
export { compileDocumentSelector };

// Select appropriate local database, prefering IndexedDb, then WebSQLDb, then LocalStorageDb, then MemoryDb
export function autoselectLocalDb(options, success, error) {
  // Here due to browserify circularity quirks
  const IndexedDb = require('./IndexedDb');
  const WebSQLDb = require('./WebSQLDb');
  const LocalStorageDb = require('./LocalStorageDb');
  const MemoryDb = require('./MemoryDb');

  // Get browser capabilities
  const {
    browser
  } = bowser;

  // Browsers with no localStorage support don't deserve anything better than a MemoryDb
  if (!isLocalStorageSupported()) {
    return new MemoryDb(options, success);
  }

  // Always use WebSQL in cordova
  if (window.cordova) {
    if ((window.device?.platform === "iOS") && window.sqlitePlugin) {
      console.log("Selecting WebSQLDb(sqlite) for Cordova");
      options.storage = 'sqlite';
      return new WebSQLDb(options, success, error);
    } else {
      console.log("Selecting else WebSQLDb for Cordova");
      // WebSQLDb must success in Cordova
      return new WebSQLDb(options, success, error);
    }
  }

  // Use IndexedDb for ios, Safari
  if (browser.ios || browser.safari) {
    // Fallback to IndexedDb
    return new IndexedDb(options, success, err => {
      console.log("Failed to create IndexedDb: " + (err ? err.message : undefined));
      // Create memory db instead
      return new MemoryDb(options, success);
    });
  }

  // Use WebSQL in Android, Chrome,  Opera, Blackberry if supports it
  if (browser.android || browser.chrome || browser.opera || browser.blackberry) {
    if (typeof window.openDatabase === "function") {
      console.log("Selecting WebSQLDb for browser");
      return new WebSQLDb(options, success, err => {
        console.log("Failed to create WebSQLDb: " + (err ? err.message : undefined));

        // Fallback to IndexedDb
        return new IndexedDb(options, success, err => {
          console.log("Failed to create IndexedDb: " + (err ? err.message : undefined));
          // Create memory db instead
          return new MemoryDb(options, success);
        });
      });
    } else { 
      // Fallback to IndexedDb
      console.log("Selecting IndexedDb for browser as WebSQL not supported");
      return new IndexedDb(options, success, err => {
        console.log("Failed to create IndexedDb: " + (err ? err.message : undefined));
        // Create memory db instead
        return new MemoryDb(options, success);
      });
    }
  }

  // Use IndexedDb on Firefox >= 16
  if (browser.firefox && (browser.version >= 16)) {
    console.log("Selecting IndexedDb for browser");
    return new IndexedDb(options, success, err => {
      console.log("Failed to create IndexedDb: " + (err ? err.message : undefined));
      // Create memory db instead
      return new MemoryDb(options, success);
    });
  }

  // Use Local Storage otherwise
  console.log("Selecting LocalStorageDb for fallback");
  return new LocalStorageDb(options, success, error);
}

// Migrates a local database's pending upserts and removes from one database to another
// Useful for upgrading from one type of database to another
export function migrateLocalDb(fromDb, toDb, success, error) {
  // Migrate collection using a HybridDb
  // Here due to browserify circularity quirks
  const HybridDb = require('./HybridDb');
  const hybridDb = new HybridDb(fromDb, toDb);
  for (let name in fromDb.collections) {
    const col = fromDb.collections[name];
    if (toDb[name]) {
      hybridDb.addCollection(name);
    }
  }

  return hybridDb.upload(success, error);
}

// Clone a local database's caches, pending upserts and removes from one database to another
// Useful for making a replica
export function cloneLocalDb(fromDb, toDb, success, error) {
  let name;
  for (name in fromDb.collections) {
    // TODO Assumes synchronous addCollection
    const col = fromDb.collections[name];
    if (!toDb[name]) {
      toDb.addCollection(name);
    }
  }

  // First cache all data
  return async.each(_.values(fromDb.collections), (fromCol, cb) => {
    const toCol = toDb[fromCol.name];

    // Get all items
    return fromCol.find({}).fetch(items => {
      // Seed items
      return toCol.seed(items, () => {
        // Copy upserts
        return fromCol.pendingUpserts(upserts => {
          return toCol.upsert(_.pluck(upserts, "doc"), _.pluck(upserts, "base"), () => {
            // Copy removes
            return fromCol.pendingRemoves(removes => {
              return async.eachSeries(removes, (remove, cb2) => {
                return toCol.remove(remove, () => {
                  return cb2();
                }
                , cb2);
              }
              , cb);
            }
            , cb);
          }
          , cb);
        }
        , cb);
      }
      , cb);
    }
    , cb);
  }
  , err => {
    if (err) {
      return error(err);
    }

    return success();
  });
}

// Clone a local database collection's caches, pending upserts and removes from one database to another
// Useful for making a replica
export function cloneLocalCollection(fromCol, toCol, success, error) {
  // Get all items
  return fromCol.find({}).fetch(items => {
    // Seed items
    return toCol.seed(items, () => {
      // Copy upserts
      return fromCol.pendingUpserts(upserts => {
        return toCol.upsert(_.pluck(upserts, "doc"), _.pluck(upserts, "base"), () => {
          // Copy removes
          return fromCol.pendingRemoves(removes => {
            return async.eachSeries(removes, (remove, cb2) => {
              return toCol.remove(remove, () => {
                return cb2();
              }
              , cb2);
            }
            , err => {
              if (err) {
                return error(err);
              }
              return success();
            });
          }
          , error);
        }
        , error);
      }
      , error);
    }
    , error);
  }
  , error);
}

// Processes a find with sorting and filtering and limiting
export function processFind(items, selector, options) {
  let filtered = _.filter(items, compileDocumentSelector(selector));

  // Handle geospatial operators
  filtered = processNearOperator(selector, filtered);
  filtered = processGeoIntersectsOperator(selector, filtered);

  if (options && options.sort) {
    filtered.sort(compileSort(options.sort));
  }

  if (options && options.skip) {
    filtered = _.slice(filtered, options.skip);
  }

  if (options && options.limit) {
    filtered = _.take(filtered, options.limit);
  }

  // Apply fields if present
  if (options && options.fields) {
    filtered = exports.filterFields(filtered, options.fields);
  }

  return filtered;
}

export function filterFields(items, fields={}) {
  // Handle trivial case
  if (_.keys(fields).length === 0) {
    return items;
  }

  // For each item
  return _.map(items, function(item) {
    let field, obj, path, pathElem;
    const newItem = {};

    if (_.first(_.values(fields)) === 1) {
      // Include fields
      for (field of _.keys(fields).concat(["_id"])) {
        path = field.split(".");

        // Determine if path exists
        obj = item;
        for (pathElem of path) {
          if (obj) {
            obj = obj[pathElem];
          }
        }

        if ((obj == null)) {
          continue;
        }

        // Go into path, creating as necessary
        let from = item;
        let to = newItem;
        for (pathElem of _.initial(path)) {
          to[pathElem] = to[pathElem] || {};

          // Move inside
          to = to[pathElem];
          from = from[pathElem];
        }

        // Copy value
        to[_.last(path)] = from[_.last(path)];
      }

      return newItem;
    } else {
      // Deep clone as we will be deleting keys from item to exclude fields
      item = _.cloneDeep(item);

      // Exclude fields
      for (field of _.keys(fields)) {
        path = field.split(".");

        // Go inside path
        obj = item;
        for (pathElem of _.initial(path)) {
          if (obj) {
            obj = obj[pathElem];
          }
        }

        // If not there, don't exclude
        if ((obj == null)) {
          continue;
        }

        delete obj[_.last(path)];
      }

      return item;
    }
  });
}

// Creates a unique identifier string
export function createUid() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (Math.random()*16)|0;
    const v = c === 'x' ? r : ((r&0x3)|0x8);
    return v.toString(16);
   });
}

var processNearOperator = function(selector, list) {
  for (var key in selector) {
    var value = selector[key];
    if ((value != null) && value['$near']) {
      var geo = value['$near']['$geometry'];
      if (geo.type !== 'Point') {
        break;
      }

      list = _.filter(list, doc => doc[key] && (doc[key].type === 'Point'));

      // Get distances
      let distances = _.map(list, doc => ({
        doc,

        distance: getDistanceFromLatLngInM(
            geo.coordinates[1], geo.coordinates[0],
            doc[key].coordinates[1], doc[key].coordinates[0])
      }));

      // Filter non-points
      distances = _.filter(distances, item => item.distance >= 0);

      // Sort by distance
      distances = _.sortBy(distances, 'distance');

      // Filter by maxDistance
      if (value['$near']['$maxDistance']) {
        distances = _.filter(distances, item => item.distance <= value['$near']['$maxDistance']);
      }

      // Extract docs
      list = _.pluck(distances, 'doc');
    }
  }
  return list;
};

const pointInPolygon = (point, polygon) => booleanPointInPolygon(point, polygon);

const polygonIntersection = (polygon1, polygon2) => intersect(polygon1, polygon2) != null;

// From http://www.movable-type.co.uk/scripts/latlong.html
var getDistanceFromLatLngInM = function(lat1, lng1, lat2, lng2) {
  const R = 6370986; // Radius of the earth in m
  const dLat = deg2rad(lat2 - lat1); // deg2rad below
  const dLng = deg2rad(lng2 - lng1);
  const a = (Math.sin(dLat / 2) * Math.sin(dLat / 2)) + (Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2));
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c; // Distance in m
  return d;
};

var deg2rad = deg => deg * (Math.PI / 180);

var processGeoIntersectsOperator = function(selector, list) {
  for (var key in selector) {
    const value = selector[key];
    if ((value != null) && value['$geoIntersects']) {
      var geo = value['$geoIntersects']['$geometry'];
      // Can only test intersection with polygon
      if (geo.type !== 'Polygon') {
        break;
      }

      // Check within for each
      list = _.filter(list, function(doc) {
        // Ignore if null
        if (!doc[key]) {
          return false;
        }

        // Check point or polygon
        if (doc[key].type === 'Point') {
          return pointInPolygon(doc[key], geo);
        } else if (["Polygon", "MultiPolygon"].includes(doc[key].type)) {
          return polygonIntersection(doc[key], geo);
        } else if (doc[key].type === "LineString") {
          return booleanCrosses(doc[key], geo) || booleanWithin(doc[key], geo);
        } else if (doc[key].type === "MultiLineString") {
          // Bypass deficiencies in turf.js by splitting it up
          for (let line of doc[key].coordinates) {
            const lineGeo = { type: "LineString", coordinates: line };
            if (booleanCrosses(lineGeo, geo) || booleanWithin(lineGeo, geo)) {
              return true;
            }
          }
          return false;
        }
      });
    }
  }

  return list;
};

// Tidy up upsert parameters to always be a list of { doc: <doc>, base: <base> },
// doing basic error checking and making sure that _id is present
// Returns [items, success, error]
export function regularizeUpsert(docs, bases, success, error) {
  // Handle case of bases not present
  if (_.isFunction(bases)) {
    [bases, success, error] = [undefined, bases, success];
  }

  // Handle single upsert
  if (!_.isArray(docs)) {
    docs = [docs];
    bases = [bases];
  } else {
    bases = bases || [];
  }

  // Make into list of { doc: .., base: }
  const items = _.map(docs, (doc, i) => ({
    doc,
    base: i < bases.length ? bases[i] : undefined
  }));

  // Set _id
  for (let item of items) {
    if (!item.doc._id) {
      item.doc._id = exports.createUid();
    }
    if (item.base && !item.base._id) {
      throw new Error("Base needs _id");
    }
    if (item.base && (item.base._id !== item.doc._id)) {
      throw new Error("Base needs same _id");
    }
  }

  return [items, success, error];
}
