'use strict';

var Utils = require('../../utils')
  , DataTypes = require('./data-types')
  , Model = require('../../model')
  , _ = require('lodash')
  , util = require('util')
  , AbstractQueryGenerator = require('../abstract/query-generator');

module.exports = (function() {
  var QueryGenerator = {
    options: {},
    dialect: 'mssql',

    createSchema: function(schema) {
      return [
        'IF NOT EXISTS (SELECT schema_name',
        'FROM information_schema.schemata',
        'WHERE schema_name =', wrapSingleQuote(schema), ')',
        'BEGIN',
          'EXEC sp_executesql N\'CREATE SCHEMA', this.quoteIdentifier(schema),';\'',
        "END;"
      ].join(' ');
    },

    showSchemasQuery: function() {
      return [
        'SELECT "name" as "schema_name" FROM sys.schemas as s',
        'WHERE "s"."name" NOT IN (',
          "'INFORMATION_SCHEMA', 'dbo', 'guest', 'sys', 'archive'",
        ")", "AND", '"s"."name" NOT LIKE', "'db_%'"
      ].join(' ');
    },

    versionQuery: function() {
      return "SELECT @@VERSION as 'version'";
    },

    createTableQuery: function(tableName, attributes, options) {
      var query = "IF OBJECT_ID('[<%= escapedTable %>]', 'U') IS NULL CREATE TABLE <%= table %> (<%= attributes %>)"
        , primaryKeys = []
        , foreignKeys = {}
        , attrStr = []
        , self = this;

      for (var attr in attributes) {
        if (attributes.hasOwnProperty(attr)) {
          var dataType = attributes[attr]
            , match;

          if (Utils._.includes(dataType, 'PRIMARY KEY')) {
            primaryKeys.push(attr);

            if (Utils._.includes(dataType, 'REFERENCES')) {
               // MSSQL doesn't support inline REFERENCES declarations: move to the end
              match = dataType.match(/^(.+) (REFERENCES.*)$/);
              attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1].replace(/PRIMARY KEY/, ''));
              foreignKeys[attr] = match[2];
            } else {
              attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType.replace(/PRIMARY KEY/, ''));
            }
          } else if (Utils._.includes(dataType, 'REFERENCES')) {
            // MSSQL doesn't support inline REFERENCES declarations: move to the end
            match = dataType.match(/^(.+) (REFERENCES.*)$/);
            attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1]);
            foreignKeys[attr] = match[2];
          } else {
            attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType);
          }
        }
      }

      var values = {
        escapedTable: this.quoteTable(tableName).replace(/"/g, ''),
        table: this.quoteTable(tableName),
        attributes: attrStr.join(', '),
      }
      , pkString = primaryKeys.map(function(pk) { return this.quoteIdentifier(pk); }.bind(this)).join(', ');

      if (!!options.uniqueKeys) {
        Utils._.each(options.uniqueKeys, function(columns, indexName) {
          if (!Utils._.isString(indexName)) {
            indexName = 'uniq_' + tableName + '_' + columns.fields.join('_');
          }
          values.attributes += ', CONSTRAINT ' + self.quoteIdentifier(indexName) + ' UNIQUE (' + Utils._.map(columns.fields, self.quoteIdentifier).join(', ') + ')';
        });
      }

      if (pkString.length > 0) {
        values.attributes += ', PRIMARY KEY (' + pkString + ')';
      }

      for (var fkey in foreignKeys) {
        if (foreignKeys.hasOwnProperty(fkey)) {
          values.attributes += ', FOREIGN KEY (' + this.quoteIdentifier(fkey) + ') ' + foreignKeys[fkey];
        }
      }

      return Utils._.template(query)(values).trim() + ';';
    },

    describeTableQuery: function(tableName, schema, schemaDelimiter) {
      var table = tableName;
      if (schema) {
        table = schema + '.' + tableName;
      }

      return [
        "SELECT c.COLUMN_NAME AS 'Name', c.DATA_TYPE AS 'Type',",
        "c.IS_NULLABLE as 'IsNull' , COLUMN_DEFAULT AS 'Default'",
        "FROM INFORMATION_SCHEMA.TABLES t ",
        "INNER JOIN INFORMATION_SCHEMA.COLUMNS c ON t.TABLE_NAME = c.TABLE_NAME",
        "where t.TABLE_NAME =",
          wrapSingleQuote(table),
        ";"
      ].join(" ");
    },

    renameTableQuery: function(before, after) {
      var query = 'EXEC sp_rename <%= before %>, <%= after %>;';
      return Utils._.template(query)({
        before: this.quoteTable(before),
        after: this.quoteTable(after)
      });
    },

    showTablesQuery: function () {
      return 'SELECT name FROM sys.tables;';
    },

    dropTableQuery: function(tableName, options) {
      var query = "IF OBJECT_ID('[<%= escapedTable %>]', 'U') IS NOT NULL DROP TABLE <%= table %>";
      var values = {
        escapedTable: this.quoteTable(tableName).replace(/"/g, ''),
        table: this.quoteTable(tableName)
      };

      return Utils._.template(query)(values).trim() + ";";
    },

    addColumnQuery: function(table, key, dataType) {
      // FIXME: attributeToSQL SHOULD be using attributes in addColumnQuery
      //        but instead we need to pass the key along as the field here
      dataType.field = key;

      var query = 'ALTER TABLE <%= table %> ADD <%= attribute %>;'
        , attribute = Utils._.template('<%= key %> <%= definition %>')({
          key: this.quoteIdentifier(key),
          definition: this.attributeToSQL(dataType, {
            context: 'addColumn'
          })
        });

      return Utils._.template(query)({
        table: this.quoteTable(table),
        attribute: attribute
      });
    },

    removeColumnQuery: function(tableName, attributeName) {
      var query = 'ALTER TABLE <%= tableName %> DROP <%= attributeName %>;';
      return Utils._.template(query)({
        tableName: this.quoteTable(tableName),
        attributeName: this.quoteIdentifier(attributeName)
      });
    },

    changeColumnQuery: function(tableName, attributes) {
      var query = 'ALTER TABLE <%= tableName %> ALTER COLUMN <%= attributes %>;';
      var attrString = [];

      for (var attrName in attributes) {
        var definition = attributes[attrName];

        attrString.push(Utils._.template('<%= attrName %> <%= definition %>')({
          attrName: this.quoteIdentifier(attrName),
          definition: definition
        }));
      }

      return Utils._.template(query)({
        tableName: this.quoteTable(tableName),
        attributes: attrString.join(', ')
      });
    },

    renameColumnQuery: function(tableName, attrBefore, attributes) {
      var query = "EXEC sp_rename '<%= tableName %>.<%= before %>', '<%= after %>', 'COLUMN';"
        , newName = Object.keys(attributes)[0];

      return Utils._.template(query)({
        tableName: this.quoteTable(tableName),
        before: attrBefore,
        after: newName
      });
    },

    bulkInsertQuery: function(tableName, attrValueHashes, options, attributes) {
      var query = 'INSERT INTO <%= table %> (<%= attributes %>) VALUES <%= tuples %>;'
        , emptyQuery = 'INSERT INTO <%= table %> DEFAULT VALUES'
        , tuples = []
        , allAttributes = []
        , needIdentityInsertWrapper = false
        , allQueries = [];

      Utils._.forEach(attrValueHashes, function(attrValueHash, i) {
        // special case for empty objects with primary keys
        var fields = Object.keys(attrValueHash);
        if (fields.length === 1 && attributes[fields[0]].autoIncrement && attrValueHash[fields[0]] === null) {
          allQueries.push(emptyQuery);
          return;
        }

        // normal case
        Utils._.forOwn(attrValueHash, function(value, key, hash) {
          if (value !== null && attributes[key].autoIncrement) {
            needIdentityInsertWrapper = true;
          }

          if (allAttributes.indexOf(key) === -1) {
            if (value === null && attributes[key].autoIncrement)
              return;

            allAttributes.push(key);
          }
        });
      });

      if (allAttributes.length > 0) {
        Utils._.forEach(attrValueHashes, function(attrValueHash, i) {
          tuples.push('(' +
            allAttributes.map(function(key) {
              return this.escape(attrValueHash[key]);
            }.bind(this)).join(',') +
          ')');
        }.bind(this));

        allQueries.push(query);
      }

      var replacements = {
        table: this.quoteTable(tableName),
        attributes: allAttributes.map(function(attr) {
                      return this.quoteIdentifier(attr);
                    }.bind(this)).join(','),
        tuples: tuples
      };

      var generatedQuery = Utils._.template(allQueries.join(';'))(replacements);
      if (needIdentityInsertWrapper) {
        generatedQuery = [
          'SET IDENTITY_INSERT', this.quoteTable(tableName), 'ON;',
          generatedQuery,
          'SET IDENTITY_INSERT', this.quoteTable(tableName), 'OFF;',
        ].join(' ');
      }

      return generatedQuery;
    },

    deleteQuery: function(tableName, where, options) {
      options = options || {};

      var table = this.quoteTable(tableName);
      if (options.truncate === true) {
        // Truncate does not allow LIMIT and WHERE
        return 'TRUNCATE TABLE ' + table;
      }

      where = this.getWhereConditions(where);
      var limit = ''
        , query = 'DELETE<%= limit %> FROM <%= table %> WHERE <%= where %>; ' +
                  'SELECT @@ROWCOUNT AS AFFECTEDROWS;';

      if (Utils._.isUndefined(options.limit)) {
        options.limit = 1;
      }

      if (!!options.limit) {
        limit = ' TOP(' + this.escape(options.limit) + ')';
      }

      return Utils._.template(query)({
        limit: limit,
        table: table,
        where: where,
      });
    },

    showIndexQuery: function(tableName, options) {
      // FIXME: temporary until I implement proper schema support
      var dequotedTableName = tableName.toString().replace(/['"]+/g, '');
      var sql = "EXEC sys.sp_helpindex @objname = N'[<%= tableName %>]';";
      return Utils._.template(sql)({
        tableName: dequotedTableName
      });
    },

    removeIndexQuery: function(tableName, indexNameOrAttributes) {
      var sql = 'DROP INDEX <%= indexName %> ON <%= tableName %>'
        , indexName = indexNameOrAttributes;

      if (typeof indexName !== 'string') {
        indexName = Utils.inflection.underscore(tableName + '_' + indexNameOrAttributes.join('_'));
      }

      var values = {
        tableName: this.quoteIdentifiers(tableName),
        indexName: indexName
      };

      return Utils._.template(sql)(values);
    },

    attributeToSQL: function(attribute, options) {
      if (!Utils._.isPlainObject(attribute)) {
        attribute = {
          type: attribute
        };
      }

      // handle self referential constraints
      if (attribute.Model && attribute.Model.tableName === attribute.references) {
        this.sequelize.log('MSSQL does not support self referencial constraints, '
          + 'we will remove it but we recommend restructuring your query');
        attribute.onDelete = '';
        attribute.onUpdate = '';
      }

      var template;
      if (attribute.type.toString() === DataTypes.ENUM.toString()) {
        // enums are a special case
        template = 'VARCHAR(10) NULL' /* + (attribute.allowNull ? 'NULL' : 'NOT NULL') */;
        template += ' CHECK (' + attribute.field + ' IN(' + Utils._.map(attribute.values, function(value) {
          return this.escape(value);
        }.bind(this)).join(', ') + '))';
        return template;
      } else {
        template = mssqlDataTypeMapping(null, null, attribute.type.toString());
      }

      if (attribute.allowNull === false) {
        template += ' NOT NULL';
      } else if (!attribute.primaryKey && !Utils.defaultValueSchemable(attribute.defaultValue)) {
        template += ' NULL';
      }

      if (attribute.autoIncrement) {
        template += ' IDENTITY(1,1)';
      }

      // Blobs/texts cannot have a defaultValue
      if (attribute.type !== 'TEXT' && attribute.type._binary !== true &&
          Utils.defaultValueSchemable(attribute.defaultValue)) {
        template += ' DEFAULT ' + this.escape(attribute.defaultValue);
      }

      if (attribute.unique === true) {
        template += ' UNIQUE';
      }

      if (attribute.primaryKey) {
        template += ' PRIMARY KEY';
      }

      if (attribute.references) {
        template += ' REFERENCES ' + this.quoteTable(attribute.references);

        if (attribute.referencesKey) {
          template += ' (' + this.quoteIdentifier(attribute.referencesKey) + ')';
        } else {
          template += ' (' + this.quoteIdentifier('id') + ')';
        }

        if (attribute.onDelete) {
          template += ' ON DELETE ' + attribute.onDelete.toUpperCase();
        }

        if (attribute.onUpdate) {
          template += ' ON UPDATE ' + attribute.onUpdate.toUpperCase();
        }
      }

      return template;
    },

    attributesToSQL: function(attributes, options) {
      var result = {}
        , key
        , attribute
        , existingConstraints = [];

      for (key in attributes) {
        attribute = attributes[key];

        if (attribute.references) {
          if (existingConstraints.indexOf(attribute.references.toString()) !== -1) {
            // no cascading constraints to a table more than once
            attribute.onDelete = '';
            attribute.onUpdate = '';
          } else {
            existingConstraints.push(attribute.references.toString());

            // NOTE: this really just disables cascading updates for all
            //       definitions. Can be made more robust to support the
            //       few cases where MSSQL actually supports them
            attribute.onUpdate = '';
          }

        }

        if (key && !attribute.field) attribute.field = key;
        result[attribute.field || key] = this.attributeToSQL(attribute, options);
      }

      return result;
    },

    findAutoIncrementField: function(factory) {
      var fields = [];
      for (var name in factory.attributes) {
        if (factory.attributes.hasOwnProperty(name)) {
          var definition = factory.attributes[name];

          if (definition && definition.autoIncrement) {
            fields.push(name);
          }
        }
      }

      return fields;
    },

    createTrigger: function(tableName, triggerName, timingType, fireOnArray, functionName, functionParams,
        optionsArray) {
      throwMethodUndefined('createTrigger');
    },

    dropTrigger: function(tableName, triggerName) {
      throwMethodUndefined('dropTrigger');
    },

    renameTrigger: function(tableName, oldTriggerName, newTriggerName) {
      throwMethodUndefined('renameTrigger');
    },

    createFunction: function(functionName, params, returnType, language, body, options) {
      throwMethodUndefined('createFunction');
    },

    dropFunction: function(functionName, params) {
      throwMethodUndefined('dropFunction');
    },

    renameFunction: function(oldFunctionName, params, newFunctionName) {
      throwMethodUndefined('renameFunction');
    },

    quoteIdentifier: function(identifier, force) {
        if (identifier === '*') return identifier;
        return Utils.addTicks(identifier, '"');
    },

    getForeignKeysQuery: function(tableName, schemaName) {
      return [
        'SELECT',
          'constraint_name = C.CONSTRAINT_NAME',
        'FROM',
          'INFORMATION_SCHEMA.TABLE_CONSTRAINTS C',
        "WHERE C.CONSTRAINT_TYPE = 'FOREIGN KEY'",
        'AND C.TABLE_NAME =', wrapSingleQuote(tableName)
      ].join(' ');
    },

    dropForeignKeyQuery: function(tableName, foreignKey) {
      return Utils._.template('ALTER TABLE <%= table %> DROP <%= key %>')({
        table: this.quoteTable(tableName),
        key: this.quoteIdentifier(foreignKey)
      });
    },

    setAutocommitQuery: function(value) {
      return '';
      // return 'SET IMPLICIT_TRANSACTIONS ' + (!!value ? 'OFF' : 'ON') + ';';
    },

    setIsolationLevelQuery: function(value, options) {
      if (options.parent) {
        return;
      }

      return 'SET TRANSACTION ISOLATION LEVEL ' + value + ';';
    },

    startTransactionQuery: function(transaction, options) {
      if (options.parent) {
        return 'SAVE TRANSACTION ' + this.quoteIdentifier(transaction.name) + ';';
      }

      return 'BEGIN TRANSACTION;';
    },

    commitTransactionQuery: function(options) {
      if (options.parent) {
        return;
      }

      return 'COMMIT TRANSACTION;';
    },

    rollbackTransactionQuery: function(transaction, options) {
      if (options.parent) {
        return 'ROLLBACK TRANSACTION ' + this.quoteIdentifier(transaction.name) + ';';
      }

      return 'ROLLBACK TRANSACTION;';
    },

    addLimitAndOffset: function(options, model) {
      var fragment = '';
      var offset = options.offset || 0
        , isSubQuery = options.hasIncludeWhere || options.hasIncludeRequired || options.hasMultiAssociation;

      // FIXME: This is ripped from selectQuery to determine whether there is already
      //        an ORDER BY added for a subquery. Should be refactored so we dont' need
      //        the duplication. Also consider moving this logic inside the options.order
      //        check, so that we aren't compiling this twice for every invocation.
      var mainQueryOrder = [];
      var subQueryOrder = [];
      if (options.order) {
        if (Array.isArray(options.order)) {
          options.order.forEach(function(t) {
            if (!Array.isArray(t)) {
              if (isSubQuery && !(t instanceof Model) && !(t.model instanceof Model)) {
                subQueryOrder.push(this.quote(t, model));
              }
            } else {
              if (isSubQuery && !(t[0] instanceof Model) && !(t[0].model instanceof Model)) {
                subQueryOrder.push(this.quote(t, model));
              }
              mainQueryOrder.push(this.quote(t, model));
            }
          }.bind(this));
        } else {
          mainQueryOrder.push(options.order);
        }
      }

      if (options.limit || options.offset) {
        if (!options.order || (options.include && !subQueryOrder.length)) {
          fragment += ' ORDER BY ' + this.quoteIdentifier(model.primaryKeyAttribute);
        }

        if (options.offset || options.limit) {
          fragment += ' OFFSET ' + offset + ' ROWS';
        }

        if (options.limit) {
          fragment += ' FETCH NEXT ' + options.limit + ' ROWS ONLY';
        }
      }

      return fragment;
    },

    findAssociation: function(attribute, dao) {
      throwMethodUndefined('findAssociation');
    },

    getAssociationFilterDAO: function(filterStr, dao) {
      throwMethodUndefined('getAssociationFilterDAO');
    },

    getAssociationFilterColumn: function(filterStr, dao, options) {
      throwMethodUndefined('getAssociationFilterColumn');
    },

    getConditionalJoins: function(options, originalDao) {
      throwMethodUndefined('getConditionalJoins');
    },

    booleanValue: function(value) {
      return !!value ? 1 : 0;
    }
  };

  // private methods
  function wrapSingleQuote(identifier){
    return Utils.addTicks(identifier, "'");
  }

  function mssqlDataTypeMapping(tableName, attr, dataType) {
    if (Utils._.includes(dataType, 'TINYINT(1)')) {
      dataType = dataType.replace(/TINYINT\(1\)/, 'BIT');
    }

    if (Utils._.includes(dataType, 'DATETIME')) {
      dataType = dataType.replace(/DATETIME/, 'DATETIME2');
    }

    if (Utils._.includes(dataType, 'BLOB')) {
      dataType = dataType.replace(/BLOB/, 'VARBINARY(MAX)');
    }

    return dataType;
  }

  /* istanbul ignore next */
  var throwMethodUndefined = function(methodName) {
    throw new Error('The method "' + methodName + '" is not defined! Please add it to your sql dialect.');
  };

  return Utils._.extend(Utils._.clone(AbstractQueryGenerator), QueryGenerator);
})();
