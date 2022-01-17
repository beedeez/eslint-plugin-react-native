/**
 * @fileoverview Utility functions for JSX
 */

'use strict';

const estraverse = require('estraverse');
const astUtil = require('./ast');

/**
 * Checks if a node represents a JSX element or fragment.
 * @param {object} node - node to check.
 * @returns {boolean} Whether or not the node if a JSX element or fragment.
 */
function isJSX(node) {
	return node && ['JSXElement', 'JSXFragment'].indexOf(node.type) >= 0;
}

/**
 * Check if the node is returning JSX or null
 *
 * @param {Function} isCreateElement Function to determine if a CallExpresion is
 *   a createElement one
 * @param {ASTNode} ASTnode The AST node being checked
 * @param {Context} context The context of `ASTNode`.
 * @param {Boolean} [strict] If true, in a ternary condition the node must return JSX in both cases
 * @param {Boolean} [ignoreNull] If true, null return values will be ignored
 * @returns {Boolean} True if the node is returning JSX or null, false if not
 */
function isReturningJSX(isCreateElement, ASTnode, context, strict, ignoreNull) {
	let found = false;
	astUtil.traverseReturns(ASTnode, context, (node) => {
		// Traverse return statement
		astUtil.traverse(node, {
			enter(childNode) {
				const setFound = () => {
					found = true;
					this.skip();
				};
				switch (childNode.type) {
					case 'FunctionExpression':
					case 'FunctionDeclaration':
					case 'ArrowFunctionExpression':
						// Do not traverse into inner function definitions
						return this.skip();
					case 'ConditionalExpression':
						if (!strict) break;
						if (isJSX(childNode.consequent) && isJSX(childNode.alternate)) {
							setFound();
						}
						this.skip();
						break;
					case 'LogicalExpression':
						if (!strict) break;
						if (isJSX(childNode.left) && isJSX(childNode.right)) {
							setFound();
						}
						this.skip();
						break;
					case 'JSXElement':
					case 'JSXFragment':
						setFound();
						break;
					case 'CallExpression':
						if (isCreateElement(childNode)) {
							setFound();
						}
						this.skip();
						break;
					case 'Literal':
						if (!ignoreNull && childNode.value === null) {
							setFound();
						}
						break;
					default:
				}
			},
		});

		return found && estraverse.VisitorOption.Break;
	});

	return found;
}

module.exports = {
	isJSX,
	isReturningJSX,
};
