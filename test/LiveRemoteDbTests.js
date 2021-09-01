import { assert } from 'chai';
import RemoteDb from "../src/RemoteDb";
import db_queries from "./db_queries";
import _ from 'lodash';

// @col should be a collection called with fields:
// "_id" as string, "a" as string, "b" as integer, "c" as JSON and "geo" as GeoJSON
// @reset  should remove all rows from the scratch table and then call the callback
// passed to it.
export function runTests() {
  return describe('RemoteDb', function() {
    this.timeout(10000);

    // Check that it passes all normal queries
    describe("passes queries", function() {
      return db_queries.call(this);
    });

    return describe("merging", function() {
      beforeEach(function(done) { return this.reset(done); });

      it("merges changes with base specified", function(done) {
        const base = { _id: "1", a: "1", b: 1 };

        return this.col.upsert(base, baseDoc => {
          const change1 = _.cloneDeep(baseDoc);
          change1.a = "2";

          const change2 = _.cloneDeep(baseDoc);
          change2.b = 2;

          return this.col.upsert(change1, base, doc1 => {
            assert.equal(doc1.a, "2");

            return this.col.upsert(change2, base, doc2 => {
              assert.equal(doc2.a, "2", "Should merge returned document");
              assert.equal(doc2.b, 2, "Should merge returned document");

              // Should merge on server permanently
              return this.col.findOne({ _id: "1" }, function(doc3) {
                assert.equal(doc2.a, "2", "Should merge documents");
                assert.equal(doc2.b, 2, "Should merge documents");
                return done();
              });
            });
          });
        });
      });

      return it("overrides changes with no base specified", function(done) {
        const base = { _id: "1", a: "1", b: 1 };

        return this.col.upsert(base, baseDoc => {
          const change1 = _.cloneDeep(baseDoc);
          change1.a = "2";

          const change2 = _.cloneDeep(baseDoc);
          change2.b = 2;

          return this.col.upsert(change1, base, doc1 => {
            assert.equal(doc1.a, "2");

            return this.col.upsert(change2, null, function(doc2) {
              assert.equal(doc2.a, "1", "Should not merge returned document");
              assert.equal(doc2.b, 2, "Should keep new value");
              return done();
            });
          });
        });
      });
    });
  });
}