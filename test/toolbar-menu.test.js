import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wireActionMenu, closeAllMenus } from '../js/layout-ui.js';

// wireActionMenu is the one mechanism behind every toolbar popover — the
// overflow menu, Display, Model, File. It used to be copy-pasted per menu, so a
// fix landed in one and not the others. These lock the behaviour the toolbar
// depends on, in particular the split the copies never agreed on: a menu of
// *actions* closes when you pick one, a menu of *settings* stays open so the
// next checkbox is one click away rather than two.
//
// The stub below is only as much DOM as the helper touches. It is not a browser
// and does not pretend to be — it models element membership, classes,
// attributes, and event dispatch, which is the whole of the helper's world.

function makeDom() {
  const listeners = { document: {}, window: {} };

  function el(id, { classes = [], children = [] } = {}) {
    const node = {
      id,
      children,
      parent: null,
      attrs: {},
      style: {},
      offsetWidth: 200,
      _classes: new Set(classes),
      _handlers: {},
      classList: {
        add: c => node._classes.add(c),
        remove: c => node._classes.delete(c),
        contains: c => node._classes.has(c),
        toggle: (c, on) => (on ? node._classes.add(c) : node._classes.delete(c))
      },
      setAttribute: (k, v) => { node.attrs[k] = v; },
      getAttribute: k => node.attrs[k],
      addEventListener: (type, fn) => { (node._handlers[type] ||= []).push(fn); },
      getBoundingClientRect: () => ({ right: 300, bottom: 40 }),
      // Membership, the way Node.contains works: self counts.
      contains(other) {
        if (other === node) return true;
        return node.children.some(c => c.contains(other));
      }
    };
    node.children.forEach(c => { c.parent = node; });
    return node;
  }

  /** Dispatch a click at `target`, bubbling to document unless stopped. */
  function click(target, chain) {
    let stopped = false;
    const event = {
      target,
      stopPropagation: () => { stopped = true; },
      // Stands in for Element.closest(selector) over the ancestor chain.
      closest: null
    };
    // `closest` is called on event.target in the helper.
    target.closest = sel => {
      const wanted = sel.split(',').map(s => s.trim());
      for (let n = target; n; n = n.parent) {
        if (wanted.includes(n.tag)) return n;
      }
      return null;
    };
    for (const node of chain) {
      (node._handlers.click || []).forEach(fn => fn(event));
      if (stopped) return;
    }
    (listeners.document.click || []).forEach(fn => fn(event));
  }

  const registry = [];
  globalThis.document = {
    addEventListener: (type, fn) => { (listeners.document[type] ||= []).push(fn); },
    querySelectorAll: sel => {
      assert.equal(sel, '.popover:not(.hidden)', 'only the open-popover query is stubbed');
      return registry.filter(n => n._classes.has('popover') && !n._classes.has('hidden'));
    },
    querySelector: sel => {
      const m = /^\[aria-controls="(.+)"\]$/.exec(sel);
      return m ? registry.find(n => n.attrs['aria-controls'] === m[1]) || null : null;
    }
  };
  globalThis.window = {
    innerWidth: 1400,
    addEventListener: (type, fn) => { (listeners.window[type] ||= []).push(fn); }
  };

  return { el, click, register: node => { registry.push(node); return node; } };
}

/** A button that opens `menu`, with one action item and one checkbox inside. */
function menuFixture(dom, { menuId = 'test-menu' } = {}) {
  const item = dom.el('item');
  item.tag = 'button';
  // As in the real Display menu, each checkbox sits inside a `label.check-row`
  // — so `closest('button, label')` matches it, and only `closeOnChoice` keeps
  // the menu up. A bare input would match nothing and pass for the wrong reason.
  const checkbox = dom.el('cb');
  checkbox.tag = 'input';
  const row = dom.el('row', { children: [checkbox] });
  row.tag = 'label';

  const menu = dom.register(dom.el(menuId, {
    classes: ['popover', 'hidden'],
    children: [item, row]
  }));
  const button = dom.register(dom.el('btn'));
  button.tag = 'button';
  button.setAttribute('aria-controls', menuId);
  const outside = dom.el('elsewhere');

  return { button, menu, item, row, checkbox, outside };
}

test('the button opens its menu and closes it again', () => {
  const dom = makeDom();
  const { button, menu } = menuFixture(dom);
  wireActionMenu(button, menu);

  assert.ok(menu.classList.contains('hidden'), 'starts closed');

  dom.click(button, [button]);
  assert.ok(!menu.classList.contains('hidden'), 'opens on click');
  assert.equal(button.getAttribute('aria-expanded'), 'true');

  dom.click(button, [button]);
  assert.ok(menu.classList.contains('hidden'), 'the same button closes it');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('a menu of actions closes once an item is chosen', () => {
  const dom = makeDom();
  const { button, menu, item } = menuFixture(dom);
  wireActionMenu(button, menu);
  dom.click(button, [button]);

  dom.click(item, [item, menu]);
  assert.ok(menu.classList.contains('hidden'), 'picking an action dismisses the menu');
});

test('a menu of settings stays open as boxes are ticked', () => {
  // Display is a panel of checkboxes: closing after each one would make setting
  // three options three round trips to the toolbar.
  const dom = makeDom();
  const { button, menu, row, checkbox } = menuFixture(dom);
  wireActionMenu(button, menu, { closeOnChoice: false });
  dom.click(button, [button]);

  dom.click(checkbox, [checkbox, row, menu]);
  assert.ok(!menu.classList.contains('hidden'), 'ticking a box leaves the menu up');
});

test('clicking outside closes the menu, clicking inside does not', () => {
  const dom = makeDom();
  const { button, menu, item, outside } = menuFixture(dom);
  wireActionMenu(button, menu, { closeOnChoice: false });

  dom.click(button, [button]);
  dom.click(item, [item, menu]);
  assert.ok(!menu.classList.contains('hidden'), 'a click inside is not "outside"');

  dom.click(outside, [outside]);
  assert.ok(menu.classList.contains('hidden'), 'a click elsewhere dismisses it');
});

test('opening one menu closes another that is already open', () => {
  // The button handler stops propagation, so the outside-click close never sees
  // the event — without this, clicking File left Model hanging open beside it.
  const dom = makeDom();
  const a = menuFixture(dom, { menuId: 'menu-a' });
  const b = menuFixture(dom, { menuId: 'menu-b' });
  wireActionMenu(a.button, a.menu);
  wireActionMenu(b.button, b.menu);

  dom.click(a.button, [a.button]);
  dom.click(b.button, [b.button]);

  assert.ok(a.menu.classList.contains('hidden'), 'the first menu gave way');
  assert.ok(!b.menu.classList.contains('hidden'), 'the second is the open one');
  assert.equal(a.button.getAttribute('aria-expanded'), 'false');
});

test('closeAllMenus closes every open popover and resets its button', () => {
  // Escape reaches for this rather than naming each menu, so a menu added later
  // is covered the day it is added.
  const dom = makeDom();
  const a = menuFixture(dom, { menuId: 'menu-a' });
  const b = menuFixture(dom, { menuId: 'menu-b' });
  wireActionMenu(a.button, a.menu);
  wireActionMenu(b.button, b.menu);

  // Opened past the buttons, so this covers the sweep itself rather than the
  // one-at-a-time rule: two popovers up at once is exactly the state Escape has
  // to be able to clear, however it arose.
  dom.click(a.button, [a.button]);
  b.menu.classList.remove('hidden');
  b.button.setAttribute('aria-expanded', 'true');
  assert.ok(!a.menu.classList.contains('hidden') && !b.menu.classList.contains('hidden'));

  closeAllMenus();
  assert.ok(a.menu.classList.contains('hidden'), 'first menu closed');
  assert.ok(b.menu.classList.contains('hidden'), 'second menu closed');
  assert.equal(a.button.getAttribute('aria-expanded'), 'false');
  assert.equal(b.button.getAttribute('aria-expanded'), 'false');
});
