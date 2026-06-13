/* site-nav.js — site-wide top-nav enhancements for static pages.
   Loaded on every static page that carries the marketing top nav (docs, learn,
   about, compare, marketing, etc.). Upgrades the single "Learn" nav link into
   an accessible dropdown listing the learn articles.

   Single source of truth: the LEARN array below is also exposed as
   window.GTFSX_LEARN so docs-nav.js can reuse it (load this BEFORE docs-nav.js).
   To add a learn article on the static side, edit LEARN here in one place. */
(function () {
  'use strict';

  /* ── Learn articles (source of truth for static pages) ─────────────── */
  var LEARN = [
    { path: '/learn/gtfs/',              title: 'What is GTFS?' },
    { path: '/learn/gtfs-flex/',         title: 'What is GTFS-Flex?' },
    { path: '/learn/publish-gtfs-feed/', title: 'How to Publish a GTFS Feed' }
  ];
  // Expose for docs-nav.js (More-in-Learn / breadcrumbs reuse the same list).
  window.GTFSX_LEARN = LEARN;

  /* ── Inject dropdown styles once (uses the page's CSS custom props) ── */
  function injectStyles() {
    if (document.getElementById('site-nav-styles')) return;
    var css = '' +
      '.site-header nav .learn-nav{position:relative;display:inline-flex;align-items:center;}' +
      '.learn-nav-trigger{cursor:pointer;}' +
      '.learn-nav-caret{display:inline-block;margin-left:3px;font-size:0.7em;line-height:1;transition:transform 0.15s;}' +
      '.learn-nav.open .learn-nav-caret{transform:rotate(180deg);}' +
      '.learn-nav-menu{position:absolute;top:100%;left:0;margin-top:6px;min-width:230px;' +
        'background:#fff;border:1px solid var(--rule,#EADBC8);border-radius:10px;' +
        'box-shadow:0 8px 24px rgba(42,31,24,0.12);padding:6px;z-index:50;' +
        'flex-direction:column;gap:2px;display:flex;}' +
      '.learn-nav-menu[hidden]{display:none;}' +
      '.learn-nav-item{display:block;padding:8px 12px;border-radius:6px;font-size:14px;' +
        'font-weight:600;color:var(--ink,#2A1F18);text-decoration:none;white-space:nowrap;}' +
      '.learn-nav-item:hover{background:var(--bg,#FFF8F0);color:var(--accent,#E8734A);}' +
      '.learn-nav-item:focus-visible{outline:2px solid var(--accent,#E8734A);outline-offset:-2px;' +
        'background:var(--bg,#FFF8F0);color:var(--accent,#E8734A);}';
    var style = document.createElement('style');
    style.id = 'site-nav-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ── Build the Learn dropdown ──────────────────────────────────────── */
  function buildLearnDropdown() {
    var nav = document.querySelector('.site-header nav');
    if (!nav) return;

    // Find the "Learn" top-nav link (href into /learn/).
    var trigger = null;
    var links = nav.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (href.indexOf('/learn/') === 0) { trigger = links[i]; break; }
    }
    if (!trigger) return;
    if (trigger.getAttribute('data-learn-dropdown') === 'true') return; // guard
    trigger.setAttribute('data-learn-dropdown', 'true');

    injectStyles();

    // Wrap the trigger so the panel can be positioned relative to it.
    var wrap = document.createElement('span');
    wrap.className = 'learn-nav';
    trigger.parentNode.insertBefore(wrap, trigger);
    wrap.appendChild(trigger);

    // Upgrade the trigger (keep it an <a> so it still links if JS is disabled).
    trigger.classList.add('learn-nav-trigger');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'learn-nav-menu');
    var caret = document.createElement('span');
    caret.className = 'learn-nav-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = '▾'; // ▾
    trigger.appendChild(caret);

    // Build the menu.
    var menu = document.createElement('div');
    menu.className = 'learn-nav-menu';
    menu.id = 'learn-nav-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Learn');
    menu.hidden = true;

    LEARN.forEach(function (article) {
      var item = document.createElement('a');
      item.className = 'learn-nav-item';
      item.setAttribute('role', 'menuitem');
      item.href = article.path;
      item.textContent = article.title;
      item.tabIndex = -1;
      menu.appendChild(item);
    });
    wrap.appendChild(menu);

    var items = menu.querySelectorAll('.learn-nav-item');
    var openTimer = null;
    var closeTimer = null;

    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('open');
    }
    function close() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('open');
    }
    function scheduleOpen() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      if (openTimer) clearTimeout(openTimer);
      openTimer = setTimeout(open, 100);
    }
    function scheduleClose() {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(close, 200);
    }

    // Hover (with intent delay, mirrors the editor's Help menu).
    wrap.addEventListener('mouseenter', scheduleOpen);
    wrap.addEventListener('mouseleave', scheduleClose);

    // Click toggles without navigating.
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      if (menu.hidden) { open(); } else { close(); }
    });

    // Keyboard on the trigger: Enter / Space / ArrowDown open + focus first item.
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        open();
        if (items.length) items[0].focus();
      } else if (e.key === 'Escape') {
        close();
      }
    });

    // Keyboard within the menu: arrows cycle, Home/End jump, Escape returns,
    // Tab closes and moves on.
    menu.addEventListener('keydown', function (e) {
      var idx = Array.prototype.indexOf.call(items, document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(idx + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
        trigger.focus();
      } else if (e.key === 'Tab') {
        close();
      }
    });

    // Close on outside click and when focus leaves the component.
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });
    wrap.addEventListener('focusout', function (e) {
      if (!wrap.contains(e.relatedTarget)) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildLearnDropdown);
  } else {
    buildLearnDropdown();
  }
})();
