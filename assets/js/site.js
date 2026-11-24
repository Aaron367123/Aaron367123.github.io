/* Aaron Morris Jara — Portfolio interactions (no dependencies) */
(function () {
	'use strict';

	var root = document.documentElement;
	var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	root.classList.add('js');

	/* ---------- Footer year ---------- */
	var year = document.getElementById('year');
	if (year) year.textContent = new Date().getFullYear();

	/* ---------- Theme toggle ---------- */
	var themeBtn = document.getElementById('theme-toggle');
	function currentTheme() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
	function syncThemeIcon() {
		var icon = themeBtn.querySelector('i');
		icon.className = currentTheme() === 'light' ? 'fas fa-moon' : 'fas fa-sun';
		themeBtn.setAttribute('aria-label', currentTheme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
	}
	if (themeBtn) {
		syncThemeIcon();
		themeBtn.addEventListener('click', function () {
			var next = currentTheme() === 'light' ? 'dark' : 'light';
			root.setAttribute('data-theme', next);
			try { localStorage.setItem('theme', next); } catch (e) {}
			syncThemeIcon();
		});
	}

	/* ---------- Nav: scrolled state + mobile menu ---------- */
	var nav = document.getElementById('nav');
	var burger = document.getElementById('nav-burger');
	var links = document.getElementById('nav-links');

	function onScroll() { nav.classList.toggle('is-scrolled', window.scrollY > 20); }
	onScroll();
	window.addEventListener('scroll', onScroll, { passive: true });

	function setMenu(open) {
		nav.classList.toggle('is-open', open);
		burger.setAttribute('aria-expanded', String(open));
		burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
		burger.querySelector('i').className = open ? 'fas fa-times' : 'fas fa-bars';
	}
	burger.addEventListener('click', function () { setMenu(!nav.classList.contains('is-open')); });
	links.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
	document.addEventListener('click', function (e) { if (!nav.contains(e.target)) setMenu(false); });

	/* ---------- Active section highlight ---------- */
	var navLinks = Array.prototype.slice.call(links.querySelectorAll('a[href^="#"]'));
	if (navLinks.length && 'IntersectionObserver' in window) {
		var sectionObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				navLinks.forEach(function (a) {
					a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id);
				});
			});
		}, { rootMargin: '-45% 0px -50% 0px' });
		document.querySelectorAll('main section[id]').forEach(function (s) { sectionObserver.observe(s); });
	}

	/* ---------- Reveal on scroll (with stagger) ---------- */
	var reveals = document.querySelectorAll('.reveal');
	if (reduceMotion || !('IntersectionObserver' in window)) {
		reveals.forEach(function (el) { el.classList.add('is-visible'); });
	} else {
		// Stagger siblings that share a parent
		reveals.forEach(function (el) {
			var siblings = Array.prototype.filter.call(el.parentNode.children, function (c) { return c.classList.contains('reveal'); });
			var i = siblings.indexOf(el);
			if (i > 0) el.style.setProperty('--delay', Math.min(i * 0.08, 0.4) + 's');
		});
		var revealObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (entry.isIntersecting) {
					entry.target.classList.add('is-visible');
					revealObserver.unobserve(entry.target);
				}
			});
		}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
		reveals.forEach(function (el) { revealObserver.observe(el); });
	}

	/* ---------- Count-up stats ---------- */
	var counters = document.querySelectorAll('[data-count]');
	if (!reduceMotion && 'IntersectionObserver' in window) {
		var countObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				var el = entry.target, target = +el.getAttribute('data-count'), start = null;
				function step(ts) {
					if (!start) start = ts;
					var p = Math.min((ts - start) / 1200, 1);
					el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
					if (p < 1) requestAnimationFrame(step);
				}
				el.textContent = '0';
				requestAnimationFrame(step);
				countObserver.unobserve(el);
			});
		}, { threshold: 0.6 });
		counters.forEach(function (el) { countObserver.observe(el); });
	}

	/* ---------- Case study: TOC highlight ---------- */
	var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.cs-toc a'));
	if (tocLinks.length && 'IntersectionObserver' in window) {
		var tocObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				tocLinks.forEach(function (a) {
					a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id);
				});
			});
		}, { rootMargin: '-30% 0px -60% 0px' });
		document.querySelectorAll('.cs-article > section[id]').forEach(function (s) { tocObserver.observe(s); });
	}

	/* ---------- Case study: live demo iframes follow the site theme ---------- */
	var demoFrames = document.querySelectorAll('iframe[data-demo]');
	function themeForDemos() {
		// The site is dark unless the visitor picked light, so demos match that.
		return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
	}
	function loadDemos() {
		demoFrames.forEach(function (f) {
			var base = f.getAttribute('data-demo');
			f.src = base + (base.indexOf('?') === -1 ? '?' : '&') + 'theme=' + themeForDemos();
		});
	}
	if (demoFrames.length) {
		loadDemos();
		if (themeBtn) themeBtn.addEventListener('click', loadDemos);
	}

	/* ---------- Case study: copy code ---------- */
	document.querySelectorAll('.code__copy').forEach(function (btn) {
		btn.addEventListener('click', function () {
			var code = btn.closest('.code').querySelector('pre').innerText;
			var done = function () {
				btn.textContent = 'Copied!';
				setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
			};
			if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, function () {});
		});
	});

	/* ---------- Case study: lightbox ---------- */
	var galleryButtons = document.querySelectorAll('.gallery button');
	if (galleryButtons.length) {
		var box = document.createElement('div');
		box.className = 'lightbox';
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-modal', 'true');
		box.setAttribute('aria-label', 'Image viewer');
		box.innerHTML = '<button class="lightbox__close" type="button" aria-label="Close"><i class="fas fa-times"></i></button><div><img alt="" /><p></p></div>';
		document.body.appendChild(box);
		var boxImg = box.querySelector('img'), boxCap = box.querySelector('p'), lastFocus = null;
		var closeBox = function () {
			box.classList.remove('is-open');
			if (lastFocus) lastFocus.focus();
		};
		galleryButtons.forEach(function (b) {
			b.addEventListener('click', function () {
				var img = b.querySelector('img');
				var cap = b.closest('figure').querySelector('figcaption');
				boxImg.src = img.getAttribute('data-full') || img.src;
				boxImg.alt = img.alt;
				boxCap.textContent = cap ? cap.textContent : '';
				lastFocus = b;
				box.classList.add('is-open');
				box.querySelector('.lightbox__close').focus();
			});
		});
		box.addEventListener('click', function (e) { if (e.target === box || e.target.closest('.lightbox__close')) closeBox(); });
		document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.classList.contains('is-open')) closeBox(); });
	}

	/* ---------- Typed subtitle ---------- */
	var typed = document.getElementById('typed');
	var phrases = [
		'IoT devices.',
		'computer vision models.',
		'multithreaded servers.',
		'low-level software in C.',
		'data dashboards.'
	];
	if (typed && !reduceMotion) {
		var p = 0, c = 0, deleting = false;
		typed.setAttribute('aria-live', 'off');
		(function tick() {
			var word = phrases[p];
			c += deleting ? -1 : 1;
			typed.textContent = word.slice(0, c);
			var delay = deleting ? 35 : 70;
			if (!deleting && c === word.length) { deleting = true; delay = 1800; }
			else if (deleting && c === 0) { deleting = false; p = (p + 1) % phrases.length; delay = 350; }
			setTimeout(tick, delay);
		})();
	} else if (typed) {
		typed.textContent = phrases[0];
	}
})();
