// Browser translation engines (Google Translate, Edge, Safari, Firefox) swap
// React-owned text nodes for <font> wrappers. React then calls removeChild or
// insertBefore against a node that is no longer its child, the DOM throws
// NotFoundError, and the whole portal dies on the error boundary. This guard
// makes those two calls no-op instead of throw. It only ever changes behaviour
// in the case that already threw, so correct code is untouched. Must run before
// hydration, hence an inline script in the root layout head.
// See facebook/react#11538.
const GUARD = `
(function () {
  if (typeof Node === 'undefined' || !Node.prototype) return;
  var warnedRemove = false, warnedInsert = false;
  var removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) {
      if (!warnedRemove) {
        warnedRemove = true;
        console.warn('[TranslateCrashGuard] suppressed removeChild on a reparented node');
      }
      return child;
    }
    return removeChild.apply(this, arguments);
  };
  var insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      if (!warnedInsert) {
        warnedInsert = true;
        console.warn('[TranslateCrashGuard] suppressed insertBefore on a reparented reference node');
      }
      return newNode;
    }
    return insertBefore.apply(this, arguments);
  };
})();
`

export function TranslateCrashGuard() {
  return <script dangerouslySetInnerHTML={{ __html: GUARD }} />
}
