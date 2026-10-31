// Adapted from the pinned canvas bulk-script.js interpreter; PolyForm Internal Use 1.0.0.
'use strict';
			function _bsBuildHelpers() {
				const isBlank = (s) => s == null || String(s).trim() === '';
				const isNotBlank = (s) => !isBlank(s);
				const isEmpty = (s) => s == null || String(s).length === 0;
				const isNotEmpty = (s) => !isEmpty(s);
				const pad = (n) => String(n).padStart(2, '0');
				const today = () => {
					const d = new Date();
					return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
				};
				const now = () => new Date().toISOString();
				const daysFromToday = (n) => {
					const d = new Date();
					d.setDate(d.getDate() + Number(n));
					return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
				};
				return { isBlank, isNotBlank, isEmpty, isNotEmpty, today, now, daysFromToday };
			}

			const _BS_KEYWORDS = [
				'let',
				'const',
				'if',
				'else',
				'for',
				'of',
				'true',
				'false',
				'null',
				'break',
				'continue',
			];
			const _BS_OPS_MULTI = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%='];
			const _BS_OPS_SINGLE = '+-*/%<>=!?:.,;(){}[]';
			const _BS_FORBIDDEN_PROPS = new Set([
				'constructor',
				'__proto__',
				'prototype',
				'__defineGetter__',
				'__defineSetter__',
				'__lookupGetter__',
				'__lookupSetter__',
			]);
			const _BS_MAX_STEPS = 1000000;
			const _BS_BREAK = Symbol('break');
			const _BS_CONTINUE = Symbol('continue');

			function _bsTokenize(src) {
				const toks = [];
				let i = 0,
					line = 1,
					col = 1;
				const advance = () => {
					const c = src[i++];
					if (c === '\n') {
						line++;
						col = 1;
					} else {
						col++;
					}
					return c;
				};
				const peek = (n) => src[i + (n || 0)];
				const isIdStart = (c) => /[A-Za-z_$]/.test(c);
				const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);
				const isDigit = (c) => c >= '0' && c <= '9';

				while (i < src.length) {
					const c = src[i];
					if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
						advance();
						continue;
					}
					if (c === '/' && peek(1) === '/') {
						while (i < src.length && src[i] !== '\n') {
							advance();
						}
						continue;
					}
					if (c === '/' && peek(1) === '*') {
						advance();
						advance();
						while (i < src.length && !(src[i] === '*' && peek(1) === '/')) {
							advance();
						}
						if (i < src.length) {
							advance();
							advance();
						}
						continue;
					}
					const startLine = line,
						startCol = col;
					if (isDigit(c) || (c === '.' && isDigit(peek(1)))) {
						let s = '';
						while (i < src.length && (isDigit(src[i]) || src[i] === '.')) {
							s += advance();
						}
						if (s.split('.').length > 2 || Number.isNaN(Number(s))) {
							throw new Error('Malformed number "' + s + '" at line ' + startLine);
						}
						toks.push({ type: 'num', value: Number(s), line: startLine, col: startCol });
						continue;
					}
					if (c === '"' || c === "'") {
						const quote = c;
						advance();
						let s = '';
						while (i < src.length && src[i] !== quote) {
							if (src[i] === '\\') {
								advance();
								const esc = advance();
								const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0' };
								s += esc in map ? map[esc] : esc;
							} else {
								s += advance();
							}
						}
						if (i >= src.length) {
							throw new Error('Unterminated string at line ' + startLine);
						}
						advance();
						toks.push({ type: 'str', value: s, line: startLine, col: startCol });
						continue;
					}
					if (isIdStart(c)) {
						let s = '';
						while (i < src.length && isIdPart(src[i])) {
							s += advance();
						}
						const type = _BS_KEYWORDS.indexOf(s) !== -1 ? s : 'id';
						toks.push({ type, value: s, line: startLine, col: startCol });
						continue;
					}
					let matched = null;
					for (let k = 0; k < _BS_OPS_MULTI.length; k++) {
						const op = _BS_OPS_MULTI[k];
						if (src.substr(i, op.length) === op) {
							matched = op;
							break;
						}
					}
					if (matched) {
						for (let k = 0; k < matched.length; k++) {
							advance();
						}
						toks.push({ type: 'op', value: matched, line: startLine, col: startCol });
						continue;
					}
					if (_BS_OPS_SINGLE.indexOf(c) !== -1) {
						advance();
						toks.push({ type: 'op', value: c, line: startLine, col: startCol });
						continue;
					}
					throw new Error('Unexpected character "' + c + '" at line ' + startLine + ', col ' + startCol);
				}
				toks.push({ type: 'eof', line, col });
				return toks;
			}

			function _bsParse(tokens) {
				// Parse a small supported language instead of evaluating arbitrary JavaScript.
				let pos = 0;
				const peek = (n) => tokens[pos + (n || 0)];
				const eat = () => tokens[pos++];
				const check = (type, value) => {
					const t = peek();
					return t.type === type && (value === undefined || t.value === value);
				};
				const consume = (type, value, msg) => {
					if (!check(type, value)) {
						const t = peek();
						throw new Error(
							'Parse error at line ' +
								t.line +
								': expected ' +
								(value || type) +
								', got "' +
								(t.value !== undefined ? t.value : t.type) +
								'"' +
								(msg ? ' (' + msg + ')' : ''),
						);
					}
					return eat();
				};

				function parseProgram() {
					const body = [];
					while (!check('eof')) {
						body.push(parseStatement());
					}
					return { type: 'program', body };
				}
				function parseStatement() {
					if (check('let') || check('const')) {
						return parseLet();
					}
					if (check('if')) {
						return parseIf();
					}
					if (check('for')) {
						return parseFor();
					}
					if (check('break')) {
						eat();
						maybeSemi();
						return { type: 'break' };
					}
					if (check('continue')) {
						eat();
						maybeSemi();
						return { type: 'continue' };
					}
					if (check('op', '{')) {
						return parseBlock();
					}
					const expr = parseExpression();
					maybeSemi();
					return { type: 'expr', expr };
				}
				function parseLet() {
					const kind = eat().type;
					const name = consume('id', undefined, 'variable name').value;
					consume('op', '=', 'expected "="');
					const init = parseExpression();
					maybeSemi();
					return { type: 'let', kind, name, init };
				}
				function parseIf() {
					eat();
					consume('op', '(');
					const cond = parseExpression();
					consume('op', ')');
					const then = parseStatement();
					let alt = null;
					if (check('else')) {
						eat();
						alt = parseStatement();
					}
					return { type: 'if', cond, then, else: alt };
				}
				function parseFor() {
					eat();
					consume('op', '(');
					if (!(check('let') || check('const'))) {
						throw new Error('Only "for (let x of arr)" / "for (const x of arr)" form is supported');
					}
					const kind = eat().type;
					const name = consume('id').value;
					consume('of', undefined, 'expected "of"');
					const iter = parseExpression();
					consume('op', ')');
					const body = parseStatement();
					return { type: 'forof', name, kind, iterable: iter, body };
				}
				function parseBlock() {
					consume('op', '{');
					const body = [];
					while (!check('op', '}') && !check('eof')) {
						body.push(parseStatement());
					}
					consume('op', '}');
					return { type: 'block', body };
				}
				function maybeSemi() {
					if (check('op', ';')) {
						eat();
					}
				}

				function parseExpression() {
					return parseAssign();
				}
				const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%='];
				function parseAssign() {
					const left = parseTernary();
					if (check('op') && ASSIGN_OPS.indexOf(peek().value) !== -1) {
						const op = eat().value;
						const right = parseAssign();
						return { type: 'assign', op, target: left, value: right };
					}
					return left;
				}
				function parseTernary() {
					const cond = parseLogicOr();
					if (check('op', '?')) {
						eat();
						const then = parseExpression();
						consume('op', ':');
						const alt = parseExpression();
						return { type: 'ternary', cond, then, else: alt };
					}
					return cond;
				}
				function parseLogicOr() {
					let left = parseLogicAnd();
					while (check('op', '||')) {
						eat();
						left = { type: 'logical', op: '||', left, right: parseLogicAnd() };
					}
					return left;
				}
				function parseLogicAnd() {
					let left = parseEquality();
					while (check('op', '&&')) {
						eat();
						left = { type: 'logical', op: '&&', left, right: parseEquality() };
					}
					return left;
				}
				function parseEquality() {
					let left = parseComparison();
					while (check('op', '==') || check('op', '!=') || check('op', '===') || check('op', '!==')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseComparison() };
					}
					return left;
				}
				function parseComparison() {
					let left = parseAdditive();
					while (check('op', '<') || check('op', '<=') || check('op', '>') || check('op', '>=')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseAdditive() };
					}
					return left;
				}
				function parseAdditive() {
					let left = parseMultiplicative();
					while (check('op', '+') || check('op', '-')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseMultiplicative() };
					}
					return left;
				}
				function parseMultiplicative() {
					let left = parseUnary();
					while (check('op', '*') || check('op', '/') || check('op', '%')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseUnary() };
					}
					return left;
				}
				function parseUnary() {
					if (check('op', '!') || check('op', '-') || check('op', '+')) {
						const op = eat().value;
						return { type: 'unary', op, arg: parseUnary() };
					}
					return parsePostfix();
				}
				function parsePostfix() {
					let node = parsePrimary();
					while (true) {
						if (check('op', '.')) {
							eat();
							const name = consume('id', undefined, 'expected property name').value;
							node = { type: 'member', object: node, property: name, computed: false };
						} else if (check('op', '[')) {
							eat();
							const key = parseExpression();
							consume('op', ']');
							node = { type: 'member', object: node, property: key, computed: true };
						} else if (check('op', '(')) {
							eat();
							const args = [];
							if (!check('op', ')')) {
								args.push(parseExpression());
								while (check('op', ',')) {
									eat();
									args.push(parseExpression());
								}
							}
							consume('op', ')');
							node = { type: 'call', callee: node, args };
						} else {
							break;
						}
					}
					return node;
				}
				function parsePrimary() {
					const t = peek();
					if (t.type === 'num' || t.type === 'str') {
						eat();
						return { type: 'lit', value: t.value };
					}
					if (t.type === 'true') {
						eat();
						return { type: 'lit', value: true };
					}
					if (t.type === 'false') {
						eat();
						return { type: 'lit', value: false };
					}
					if (t.type === 'null') {
						eat();
						return { type: 'lit', value: null };
					}
					if (t.type === 'id') {
						eat();
						return { type: 'ident', name: t.value };
					}
					if (t.type === 'op' && t.value === '(') {
						eat();
						const e = parseExpression();
						consume('op', ')');
						return e;
					}
					throw new Error(
						'Unexpected token "' + (t.value !== undefined ? t.value : t.type) + '" at line ' + t.line,
					);
				}

				return parseProgram();
			}

			function _bsInterpret(ast, env) {
				let steps = 0;
				const _identityGuarded = new Set(Array.isArray(env.records) ? env.records : []);
				const _IDENTITY_PROPS = new Set(['id', 'loadedFromId', 'values']);
				function tick() {
					if (++steps > _BS_MAX_STEPS) {
						throw new Error('Script exceeded ' + _BS_MAX_STEPS + ' steps (possible infinite loop)');
					}
				}
				function makeScope(parent) {
					return { vars: new Map(), parent };
				}
				function lookup(scope, name) {
					let s = scope;
					while (s) {
						if (s.vars.has(name)) {
							return s.vars.get(name);
						}
						s = s.parent;
					}
					throw new Error('Undefined identifier: ' + name);
				}
				function defineVar(scope, name, value) {
					if (scope.vars.has(name)) {
						throw new Error('Variable "' + name + '" is already defined in this scope');
					}
					scope.vars.set(name, value);
				}
				function assignVar(scope, name, value) {
					let s = scope;
					while (s) {
						if (s.vars.has(name)) {
							s.vars.set(name, value);
							return;
						}
						s = s.parent;
					}
					throw new Error('Cannot assign to undeclared variable: ' + name);
				}
				function checkProp(prop) {
					if (_BS_FORBIDDEN_PROPS.has(String(prop))) {
						throw new Error('Property "' + prop + '" is not allowed');
					}
				}
				function readMember(obj, prop) {
					if (obj == null) {
						throw new Error('Cannot read property "' + prop + '" of ' + obj);
					}
					checkProp(prop);
					return obj[prop];
				}
				function writeMember(obj, prop, value) {
					if (obj == null) {
						throw new Error('Cannot write property "' + prop + '" of ' + obj);
					}
					checkProp(prop);
					if (_identityGuarded.has(obj) && _IDENTITY_PROPS.has(String(prop))) {
						throw new Error(
							'Record identity is read-only: cannot assign r.' + prop + ' (edit r.values.* instead)',
						);
					}
					obj[prop] = value;
				}
				function applyAssignOp(op, oldVal, r) {
					if (op === '=') {
						return r;
					}
					if (op === '+=') {
						return oldVal + r;
					}
					if (op === '-=') {
						return oldVal - r;
					}
					if (op === '*=') {
						return oldVal * r;
					}
					if (op === '/=') {
						return oldVal / r;
					}
					return oldVal % r;
				}

				function evalExpr(node, scope) {
					tick();
					switch (node.type) {
						case 'lit':
							return node.value;
						case 'ident':
							return lookup(scope, node.name);
						case 'member': {
							const obj = evalExpr(node.object, scope);
							const prop = node.computed ? evalExpr(node.property, scope) : node.property;
							return readMember(obj, prop);
						}
						case 'call': {
							const args = node.args.map((a) => evalExpr(a, scope));
							let fn, thisArg;
							if (node.callee.type === 'member') {
								const obj = evalExpr(node.callee.object, scope);
								const prop = node.callee.computed
									? evalExpr(node.callee.property, scope)
									: node.callee.property;
								fn = readMember(obj, prop);
								thisArg = obj;
							} else {
								fn = evalExpr(node.callee, scope);
								thisArg = undefined;
							}
							if (typeof fn !== 'function') {
								throw new Error('Cannot call non-function');
							}
							return fn.apply(thisArg, args);
						}
						case 'unary': {
							const v = evalExpr(node.arg, scope);
							if (node.op === '!') {
								return !v;
							}
							if (node.op === '-') {
								return -v;
							}
							return +v;
						}
						case 'binary': {
							const l = evalExpr(node.left, scope);
							const r = evalExpr(node.right, scope);
							switch (node.op) {
								case '+':
									return l + r;
								case '-':
									return l - r;
								case '*':
									return l * r;
								case '/':
									return l / r;
								case '%':
									return l % r;
								case '==':
									return l == r;
								case '!=':
									return l != r;
								case '===':
									return l === r;
								case '!==':
									return l !== r;
								case '<':
									return l < r;
								case '<=':
									return l <= r;
								case '>':
									return l > r;
								case '>=':
									return l >= r;
							}
							throw new Error('Unknown binary op');
						}
						case 'logical': {
							const l = evalExpr(node.left, scope);
							if (node.op === '&&') {
								return l ? evalExpr(node.right, scope) : l;
							}
							return l ? l : evalExpr(node.right, scope);
						}
						case 'ternary':
							return evalExpr(node.cond, scope) ? evalExpr(node.then, scope) : evalExpr(node.else, scope);
						case 'assign': {
							const r = evalExpr(node.value, scope);
							const target = node.target;
							if (target.type === 'ident') {
								const oldVal = node.op === '=' ? undefined : lookup(scope, target.name);
								const v = applyAssignOp(node.op, oldVal, r);
								assignVar(scope, target.name, v);
								return v;
							}
							if (target.type === 'member') {
								const obj = evalExpr(target.object, scope);
								const prop = target.computed ? evalExpr(target.property, scope) : target.property;
								const oldVal = node.op === '=' ? undefined : readMember(obj, prop);
								const v = applyAssignOp(node.op, oldVal, r);
								writeMember(obj, prop, v);
								return v;
							}
							throw new Error('Invalid assignment target');
						}
					}
					throw new Error('Unknown expression: ' + node.type);
				}

				function execStmt(node, scope) {
					tick();
					switch (node.type) {
						case 'expr':
							evalExpr(node.expr, scope);
							return;
						case 'let':
							defineVar(scope, node.name, evalExpr(node.init, scope));
							return;
						case 'block': {
							const inner = makeScope(scope);
							for (let k = 0; k < node.body.length; k++) {
								const r = execStmt(node.body[k], inner);
								if (r === _BS_BREAK || r === _BS_CONTINUE) {
									return r;
								}
							}
							return;
						}
						case 'if':
							if (evalExpr(node.cond, scope)) {
								return execStmt(node.then, scope);
							}
							if (node.else) {
								return execStmt(node.else, scope);
							}
							return;
						case 'forof': {
							const iter = evalExpr(node.iterable, scope);
							if (iter == null || typeof iter[Symbol.iterator] !== 'function') {
								throw new Error('for-of: value is not iterable');
							}
							for (const v of iter) {
								const inner = makeScope(scope);
								inner.vars.set(node.name, v);
								const r = execStmt(node.body, inner);
								if (r === _BS_BREAK) {
									break;
								}
								if (r === _BS_CONTINUE) {
									continue;
								}
							}
							return;
						}
						case 'break':
							return _BS_BREAK;
						case 'continue':
							return _BS_CONTINUE;
					}
					throw new Error('Unknown statement: ' + node.type);
				}

				const root = makeScope(null);
				Object.keys(env).forEach((k) => root.vars.set(k, env[k]));
				for (let k = 0; k < ast.body.length; k++) {
					execStmt(ast.body[k], root);
				}
			}


module.exports = { parse: source => _bsParse(_bsTokenize(source)), interpret:_bsInterpret, helpers:_bsBuildHelpers };
