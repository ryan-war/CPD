// Cross-page task links: Main task → Sub-Path page, Sub-Path task → Main task.

import { escapeHtml, toast } from './dom.js';
import { getState, pageTitle, findNodeInDiagram } from './state.js';

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
