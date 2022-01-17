/**
 * @fileoverview Utility class and functions for React components detection
 * @author Yannick Croissant
 */

'use strict';

const pragmaUtil = require('./pragma');
const isDestructuredFromPragmaImport = require('./isDestructuredFromPragmaImport');
const jsxUtil = require('./jsx');
const isCreateElement = require('./isCreateElement');

function getWrapperFunctions(context, pragma) {
  const componentWrapperFunctions =		context.settings.componentWrapperFunctions || [];

  // eslint-disable-next-line arrow-body-style
  return componentWrapperFunctions
    .map((wrapperFunction) => (typeof wrapperFunction === 'string'
      ? { property: wrapperFunction }
      : {
        ...wrapperFunction,
        object:
							wrapperFunction.object === '<pragma>'
							  ? pragma
							  : wrapperFunction.object,
				  }))
    .concat([
      { property: 'forwardRef', object: pragma },
      { property: 'memo', object: pragma },
    ]);
}

/**
 * Components
 * @class
 */
function Components() {
  this.list = {};
  this.getId = function (node) {
    return node && node.range.join(':');
  };
}

/**
 * Check if the first letter of a string is capitalized.
 * @param {String} word String to check
 * @returns {Boolean} True if first letter is capitalized.
 */
function isFirstLetterCapitalized(word) {
  if (!word) {
    return false;
  }
  const firstLetter = word.charAt(0);
  return firstLetter.toUpperCase() === firstLetter;
}

/**
 * Add a node to the components list, or update it if it's already in the list
 *
 * @param {ASTNode} node The AST node being added.
 * @param {Number} confidence Confidence in the component detection (0=banned, 1=maybe, 2=yes)
 */
Components.prototype.add = function (node, confidence) {
  const id = this.getId(node);
  if (this.list[id]) {
    if (confidence === 0 || this.list[id].confidence === 0) {
      this.list[id].confidence = 0;
    } else {
      this.list[id].confidence = Math.max(this.list[id].confidence, confidence);
    }
    return;
  }
  this.list[id] = {
    node: node,
    confidence: confidence,
  };
};

/**
 * Find a component in the list using its node
 *
 * @param {ASTNode} node The AST node being searched.
 * @returns {Object} Component object, undefined if the component is not found
 */
Components.prototype.get = function (node) {
  const id = this.getId(node);
  return this.list[id];
};

/**
 * Update a component in the list
 *
 * @param {ASTNode} node The AST node being updated.
 * @param {Object} props Additional properties to add to the component.
 */
Components.prototype.set = function (node, props) {
  let currentNode = node;
  while (currentNode && !this.list[this.getId(currentNode)]) {
    currentNode = node.parent;
  }
  if (!currentNode) {
    return;
  }
  const id = this.getId(currentNode);
  this.list[id] = { ...this.list[id], ...props };
};

/**
 * Return the components list
 * Components for which we are not confident are not returned
 *
 * @returns {Object} Components list
 */
Components.prototype.all = function () {
  const list = {};
  Object.keys(this.list).forEach((i) => {
    if ({}.hasOwnProperty.call(this.list, i) && this.list[i].confidence >= 2) {
      list[i] = this.list[i];
    }
  });
  return list;
};

/**
 * Return the length of the components list
 * Components for which we are not confident are not counted
 *
 * @returns {Number} Components list length
 */
Components.prototype.length = function () {
  let length = 0;
  Object.keys(this.list).forEach((i) => {
    if ({}.hasOwnProperty.call(this.list, i) && this.list[i].confidence >= 2) {
      length += 1;
    }
  });
  return length;
};

function componentRule(rule, context) {
  const sourceCode = context.getSourceCode();
  const components = new Components();
  const pragma = pragmaUtil.getFromContext(context);
  const wrapperFunctions = getWrapperFunctions(context, pragma);

  // Utilities for component detection
  const utils = {
    /**
		 * Check if the node is a React ES5 component
		 *
		 * @param {ASTNode} node The AST node being checked.
		 * @returns {Boolean} True if the node is a React ES5 component, false if not
		 */
    isES5Component: function (node) {
      if (!node.parent) {
        return false;
      }
      return /^(React\.)?createClass$/.test(
        sourceCode.getText(node.parent.callee)
      );
    },

    /**
		 * Check if the node is a React ES6 component
		 *
		 * @param {ASTNode} node The AST node being checked.
		 * @returns {Boolean} True if the node is a React ES6 component, false if not
		 */
    isES6Component: function (node) {
      if (!node.superClass) {
        return false;
      }
      return /^(React\.)?(Pure)?Component$/.test(
        sourceCode.getText(node.superClass)
      );
    },

    /**
		 * Checks to see if node is called within createElement from pragma
		 *
		 * @param {ASTNode} node The AST node being checked.
		 * @returns {Boolean} True if createElement called from pragma
		 */
    isCreateElement(node) {
      return isCreateElement(node, context);
    },

    /**
		 * Check if the node is returning JSX
		 *
		 * @param {ASTNode} node The AST node being checked (must be a ReturnStatement).
		 * @returns {Boolean} True if the node is returning JSX, false if not
		 */
    isReturningJSX: function (node) {
      let property;
      switch (node.type) {
        case 'ReturnStatement':
          property = 'argument';
          break;
        case 'ArrowFunctionExpression':
          property = 'body';
          break;
        default:
          return false;
      }

      const returnsJSX =				node[property]
				&& (node[property].type === 'JSXElement'
					|| node[property].type === 'JSXFragment');
      const returnsReactCreateElement =				node[property]
				&& node[property].callee
				&& node[property].callee.property
				&& node[property].callee.property.name === 'createElement';

      return Boolean(returnsJSX || returnsReactCreateElement);
    },

    /**
		 * Get the parent component node from the current scope
		 *
		 * @returns {ASTNode} component node, null if we are not in a component
		 */
    getParentComponent: function () {
      return (
        utils.getParentES6Component()
				|| utils.getParentES5Component()
				|| utils.getParentStatelessComponent()
      );
    },

    /**
		 * Get the parent ES5 component node from the current scope
		 *
		 * @returns {ASTNode} component node, null if we are not in a component
		 */
    getParentES5Component: function () {
      // eslint-disable-next-line react/destructuring-assignment
      let scope = context.getScope();
      while (scope) {
        const node =					scope.block && scope.block.parent && scope.block.parent.parent;
        if (node && utils.isES5Component(node)) {
          return node;
        }
        scope = scope.upper;
      }
      return null;
    },

    /**
		 * Get the parent ES6 component node from the current scope
		 *
		 * @returns {ASTNode} component node, null if we are not in a component
		 */
    getParentES6Component: function () {
      let scope = context.getScope();
      while (scope && scope.type !== 'class') {
        scope = scope.upper;
      }
      const node = scope && scope.block;
      if (!node || !utils.isES6Component(node)) {
        return null;
      }
      return node;
    },

    getComponentNameFromJSXElement(node) {
      if (node.type !== 'JSXElement') {
        return null;
      }
      if (
        node.openingElement
				&& node.openingElement.name
				&& node.openingElement.name.name
      ) {
        return node.openingElement.name.name;
      }
      return null;
    },

    /**
		 * Getting the first JSX element's name.
		 * @param {object} node
		 * @returns {string | null}
		 */
    getNameOfWrappedComponent(node) {
      if (node.length < 1) {
        return null;
      }
      const { body } = node[0];
      if (!body) {
        return null;
      }
      if (body.type === 'JSXElement') {
        return this.getComponentNameFromJSXElement(body);
      }
      if (body.type === 'BlockStatement') {
        const jsxElement = body.body.find(
          (item) => item.type === 'ReturnStatement'
        );
        return (
          jsxElement
					&& jsxElement.argument
					&& this.getComponentNameFromJSXElement(jsxElement.argument)
        );
      }
      return null;
    },

    /**
		 * Get the list of names of components created till now
		 * @returns {string | boolean}
		 */
    getDetectedComponents() {
      const list = components.list();
      return Object.values(list)
        .filter((val) => {
          if (val.node.type === 'ClassDeclaration') {
            return true;
          }
          if (
            val.node.type === 'ArrowFunctionExpression'
						&& val.node.parent
						&& val.node.parent.type === 'VariableDeclarator'
						&& val.node.parent.id
          ) {
            return true;
          }
          return false;
        })
        .map((val) => {
          if (val.node.type === 'ArrowFunctionExpression') {
            return val.node.parent.id.name;
          }
          return val.node.id && val.node.id.name;
        });
    },

    /**
		 * Check if variable is destructured from pragma import
		 *
		 * @param {string} variable The variable name to check
		 * @returns {Boolean} True if createElement is destructured from the pragma
		 */
    isDestructuredFromPragmaImport(variable) {
      return isDestructuredFromPragmaImport(variable, context);
    },

    isReturningOnlyNull(ASTNode) {
      return jsxUtil.isReturningOnlyNull(this.isCreateElement.bind(this), ASTNode, context);
    },

    isParentComponentNotStatelessComponent(node) {
      return !!(
        node.parent
				&& node.parent.key
				&& node.parent.key.type === 'Identifier'
				// custom component functions must start with a capital letter (returns false otherwise)
				&& node.parent.key.name.charAt(0)
					=== node.parent.key.name.charAt(0).toLowerCase()
				// react render function cannot have params
				&& !!(node.params || []).length
      );
    },

    /**
		 * It will check wheater memo/forwardRef is wrapping existing component or
		 * creating a new one.
		 * @param {object} node
		 * @returns {boolean}
		 */
    nodeWrapsComponent(node) {
      const childComponent = this.getNameOfWrappedComponent(node.arguments);
      const componentList = this.getDetectedComponents();
      return !!childComponent && componentList.includes(childComponent);
    },

    isPragmaComponentWrapper(node) {
      if (!node || node.type !== 'CallExpression') {
        return false;
      }

      return wrapperFunctions.some((wrapperFunction) => {
        if (node.callee.type === 'MemberExpression') {
          return (
            wrapperFunction.object
						&& wrapperFunction.object === node.callee.object.name
						&& wrapperFunction.property === node.callee.property.name
						&& !this.nodeWrapsComponent(node)
          );
        }
        return (
          wrapperFunction.property === node.callee.name
					&& (!wrapperFunction.object
						// Functions coming from the current pragma need special handling
						|| (wrapperFunction.object === pragma
							&& this.isDestructuredFromPragmaImport(node.callee.name)))
        );
      });
    },

    getPragmaComponentWrapper(node) {
      let isPragmaComponentWrapper;
      let currentNode = node;
      let prevNode;
      do {
        currentNode = currentNode.parent;
        isPragmaComponentWrapper = this.isPragmaComponentWrapper(currentNode);
        if (isPragmaComponentWrapper) {
          prevNode = currentNode;
        }
      } while (isPragmaComponentWrapper);

      return prevNode;
    },

    /**
		 * Get the parent stateless component node from the current scope
		 *
		 * @returns {ASTNode} component node, null if we are not in a component
		 */
    getParentStatelessComponent: function () {
      let scope = context.getScope();
      while (scope) {
        const node = scope.block;
        const statelessComponent = utils.getStatelessComponent(node);
        if (statelessComponent) {
          return statelessComponent;
        }
        scope = scope.upper;
      }
      return null;
    },

    isReturningJSXOrNull(ASTNode, strict) {
      return jsxUtil.isReturningJSX(
        this.isCreateElement.bind(this),
        ASTNode,
        context,
        strict
      );
    },

    /**
		 * @param {ASTNode} node
		 * @returns {boolean}
		 */
    isInAllowedPositionForComponent(node) {
      switch (node.parent.type) {
        case 'VariableDeclarator':
        case 'AssignmentExpression':
        case 'Property':
        case 'ReturnStatement':
        case 'ExportDefaultDeclaration':
        case 'ArrowFunctionExpression': {
          return true;
        }
        case 'SequenceExpression': {
          return (
            utils.isInAllowedPositionForComponent(node.parent)
						&& node === node.parent.expressions[node.parent.expressions.length - 1]
          );
        }
        default:
          return false;
      }
    },

    /**
		 * Get node if node is a stateless component, or node.parent in cases like
		 * `React.memo` or `React.forwardRef`. Otherwise returns `undefined`.
		 * @param {ASTNode} node
		 * @returns {ASTNode | undefined}
		 */
    getStatelessComponent(node) {
      const { parent } = node;
      if (
        node.type === 'FunctionDeclaration'
				&& (!node.id || isFirstLetterCapitalized(node.id.name))
				&& utils.isReturningJSXOrNull(node)
      ) {
        return node;
      }

      if (
        node.type === 'FunctionExpression'
				|| node.type === 'ArrowFunctionExpression'
      ) {
        const isMethod = parent.type === 'Property' && parent.method;
        const isPropertyAssignment =					parent.type === 'AssignmentExpression'
					&& parent.left.type === 'MemberExpression';
        const isModuleExportsAssignment =					isPropertyAssignment
					&& parent.left.object.name === 'module'
					&& parent.left.property.name === 'exports';

        if (node.parent.type === 'ExportDefaultDeclaration') {
          if (utils.isReturningJSX(node)) {
            return node;
          }
          return undefined;
        }

        if (
          node.parent.type === 'VariableDeclarator'
					&& utils.isReturningJSXOrNull(node)
        ) {
          if (isFirstLetterCapitalized(node.parent.id.name)) {
            return node;
          }
          return undefined;
        }

        // case: function any() { return (props) { return not-jsx-and-not-null } }
        if (
          node.parent.type === 'ReturnStatement'
					&& !utils.isReturningJSX(node)
					&& !utils.isReturningOnlyNull(node)
        ) {
          return undefined;
        }

        // for case abc = { [someobject.somekey]: props => { ... return not-jsx } }
        if (
          node.parent
					&& node.parent.key
					&& node.parent.key.type === 'MemberExpression'
					&& !utils.isReturningJSX(node)
					&& !utils.isReturningOnlyNull(node)
        ) {
          return undefined;
        }

        // Case like `React.memo(() => <></>)` or `React.forwardRef(...)`
        const pragmaComponentWrapper = utils.getPragmaComponentWrapper(node);
        if (pragmaComponentWrapper) {
          return pragmaComponentWrapper;
        }

        if (
          !(
            utils.isInAllowedPositionForComponent(node)
						&& utils.isReturningJSXOrNull(node)
          )
        ) {
          return undefined;
        }

        if (utils.isParentComponentNotStatelessComponent(node)) {
          return undefined;
        }

        if (isMethod && !isFirstLetterCapitalized(node.parent.key.name)) {
          return utils.isReturningJSX(node) ? node : undefined;
        }

        if (node.id) {
          return isFirstLetterCapitalized(node.id.name) ? node : undefined;
        }

        if (
          isPropertyAssignment
					&& !isModuleExportsAssignment
					&& !isFirstLetterCapitalized(parent.left.property.name)
        ) {
          return undefined;
        }

        return node;
      }

      return undefined;
    },

    /**
		 * Get the related component from a node
		 *
		 * @param {ASTNode} node The AST node being checked (must be a MemberExpression).
		 * @returns {ASTNode} component node, null if we cannot find the component
		 */
    getRelatedComponent: function (node) {
      let currentNode = node;
      let i;
      let j;
      let k;
      let l;
      // Get the component path
      const componentPath = [];
      while (currentNode) {
        if (
          currentNode.property
					&& currentNode.property.type === 'Identifier'
        ) {
          componentPath.push(currentNode.property.name);
        }
        if (currentNode.object && currentNode.object.type === 'Identifier') {
          componentPath.push(currentNode.object.name);
        }
        currentNode = currentNode.object;
      }
      componentPath.reverse();

      // Find the variable in the current scope
      const variableName = componentPath.shift();
      if (!variableName) {
        return null;
      }
      let variableInScope;
      const { variables } = context.getScope();
      for (i = 0, j = variables.length; i < j; i++) {
        // eslint-disable-line no-plusplus
        if (variables[i].name === variableName) {
          variableInScope = variables[i];
          break;
        }
      }
      if (!variableInScope) {
        return null;
      }

      // Find the variable declaration
      let defInScope;
      const { defs } = variableInScope;
      for (i = 0, j = defs.length; i < j; i++) {
        // eslint-disable-line no-plusplus
        if (
          defs[i].type === 'ClassName'
					|| defs[i].type === 'FunctionName'
					|| defs[i].type === 'Variable'
        ) {
          defInScope = defs[i];
          break;
        }
      }
      if (!defInScope) {
        return null;
      }
      currentNode = defInScope.node.init || defInScope.node;

      // Traverse the node properties to the component declaration
      for (i = 0, j = componentPath.length; i < j; i++) {
        // eslint-disable-line no-plusplus
        if (!currentNode.properties) {
          continue; // eslint-disable-line no-continue
        }
        for (k = 0, l = currentNode.properties.length; k < l; k++) {
          // eslint-disable-line no-plusplus, max-len
          if (currentNode.properties[k].key.name === componentPath[i]) {
            currentNode = currentNode.properties[k];
            break;
          }
        }
        if (!currentNode) {
          return null;
        }
        currentNode = currentNode.value;
      }

      // Return the component
      return components.get(currentNode);
    },
  };

  // Component detection instructions
  const detectionInstructions = {
    ClassDeclaration: function (node) {
      if (!utils.isES6Component(node)) {
        return;
      }
      components.add(node, 2);
    },

    ClassProperty: function () {
      const node = utils.getParentComponent();
      if (!node) {
        return;
      }
      components.add(node, 2);
    },

    ObjectExpression: function (node) {
      if (!utils.isES5Component(node)) {
        return;
      }
      components.add(node, 2);
    },

    FunctionExpression: function () {
      const node = utils.getParentComponent();
      if (!node) {
        return;
      }
      components.add(node, 1);
    },

    FunctionDeclaration: function () {
      const node = utils.getParentComponent();
      if (!node) {
        return;
      }
      components.add(node, 1);
    },

    ArrowFunctionExpression: function () {
      const node = utils.getParentComponent();
      if (!node) {
        return;
      }

      if (node.expression && utils.isReturningJSX(node)) {
        components.add(node, 2);
      } else {
        components.add(node, 1);
      }
    },

    ThisExpression: function () {
      const node = utils.getParentComponent();
      if (!node || !/Function/.test(node.type)) {
        return;
      }
      // Ban functions with a ThisExpression
      components.add(node, 0);
    },

    ReturnStatement: function (node) {
      if (!utils.isReturningJSX(node)) {
        return;
      }
      const parentNode = utils.getParentComponent();
      if (!parentNode) {
        return;
      }
      components.add(parentNode, 2);
    },
  };

  // Update the provided rule instructions to add the component detection
  const ruleInstructions = rule(context, components, utils);
  const updatedRuleInstructions = { ...ruleInstructions };
  Object.keys(detectionInstructions).forEach((instruction) => {
    updatedRuleInstructions[instruction] = (node) => {
      detectionInstructions[instruction](node);
      return ruleInstructions[instruction]
        ? ruleInstructions[instruction](node)
        : undefined;
    };
  });

  // Return the updated rule instructions
  return updatedRuleInstructions;
}

Components.detect = function (rule) {
  return componentRule.bind(this, rule);
};

module.exports = Components;
