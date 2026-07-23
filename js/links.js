// Cross-page task links: Main task → Sub-Path page, Sub-Path task → Main task.

import { escapeHtml, toast } from './dom.js';
import { getState, pageTitle, findNodeInDiagram } from './state.js';
import { nodesOf } from './cpm.js';

export function linkTooltip(node) {
  if (node.linkedSubPage) return `\n→ ${pageTitle(node.linkedSubPage)}`;
  if (node.linkedMainNode) {
    const main = findNodeInDiagram(node.linkedMainNode, 'main');
    const label = main ? `${node.linkedMainNode}: ${main.node.title}` : node.linkedMainNode;
    return `\n→ Main · ${label}`;
  }
  return '';
}

export function linkBadgeHtml(node) {
  if (node.linkedSubPage) {
    return `<button type="button" data-goto-page="${escapeHtml(node.linkedSubPage)}" class="link-badge link-badge-sub"><i data-lucide="external-link" class="w-3 h-3" aria-hidden="true"></i>${escapeHtml(pageTitle(node.linkedSubPage))}</button>`;
  }
  if (node.linkedMainNode) {
    const main = findNodeInDiagram(node.linkedMainNode, 'main');
    const label = main ? `Main · ${node.linkedMainNode}` : `Main · ${node.linkedMainNode}?`;
    return `<button type="button" data-goto-main="${escapeHtml(node.linkedMainNode)}" class="link-badge link-badge-main"><i data-lucide="corner-up-left" class="w-3 h-3" aria-hidden="true"></i>${escapeHtml(label)}</button>`;
  }
  return '';
}

/**
 * Sub-paths arranged under the Main task that owns each one.
 *
 * A flat strip of pages said nothing about what any of them belonged to, and
 * the answer is already in the project: the Main task whose `linkedSubPage`
 * points at the page. Derived on every render rather than stored, so no file
 * needs migrating and nothing can fall out of step with the links themselves.
 *
 * A page linked from several Main tasks is grouped under the first — a tab can
 * only sit in one place. Pages nobody links land in a final group with
 * `mainNodeId: null`.
 *
 * @returns {{mainNodeId: string|null, mainTitle: string, pages: string[]}[]}
 */
export function groupPagesByMainNode() {
  const state = getState();
  const order = state.pageOrder || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const groups = new Map();
  const owner = new Map();

  nodesOf(state.diagrams.main).forEach(node => {
    const pageId = node.linkedSubPage;
    if (!pageId || pageId === 'main' || !state.diagrams[pageId] || owner.has(pageId)) return;
    owner.set(pageId, node.id);

    if (!groups.has(node.id)) {
      groups.set(node.id, {
        mainNodeId: node.id,
        mainTitle: node.title || node.id,
        pages: []
      });
    }
    groups.get(node.id).pages.push(pageId);
  });

  const unlinked = order.filter(id => id !== 'main' && !owner.has(id));
  const result = [...groups.values()];
  if (unlinked.length) {
    result.push({ mainNodeId: null, mainTitle: 'Not linked', pages: unlinked });
  }

  // Within a group the user's own page order still decides.
  result.forEach(group => group.pages.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)));
  return result;
}

/**
 * Navigate a task's link.
 * @param {object} node task (or `{linkedMainNode}` shorthand from a badge)
 * @param {{switchView: Function, focusNode: Function}} nav
 * @returns {boolean} whether navigation happened
 */
export function followNodeLink(node, nav) {
  const state = getState();
  if (node.linkedSubPage && state.diagrams[node.linkedSubPage]) {
    nav.switchView(node.linkedSubPage);
    return true;
  }
  if (node.linkedMainNode) {
    if (!findNodeInDiagram(node.linkedMainNode, 'main')) {
      toast(`Main task "${node.linkedMainNode}" not found`, 'error');
      return false;
    }
    nav.switchView('main');
    nav.focusNode(node.linkedMainNode);
    return true;
  }
  return false;
}
