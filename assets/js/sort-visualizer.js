/* Sorting visualizer + live benchmark (descending order, mirroring the Java assignment) */
(function () {
	'use strict';

	var root = document.getElementById('sorter');
	if (!root) return;

	var stage = root.querySelector('.sorter__bars');
	var algoSel = root.querySelector('#sorter-algo');
	var sizeIn = root.querySelector('#sorter-size');
	var sizeOut = root.querySelector('#sorter-size-out');
	var speedIn = root.querySelector('#sorter-speed');
	var runBtn = root.querySelector('#sorter-run');
	var shuffleBtn = root.querySelector('#sorter-shuffle');
	var statCmp = root.querySelector('#stat-cmp');
	var statWr = root.querySelector('#stat-wr');
	var statStatus = root.querySelector('#stat-status');

	var data = [], bars = [], running = false, cancel = false;

	function rand(n) {
		var a = [];
		for (var i = 0; i < n; i++) a.push(1 + Math.floor(Math.random() * 100));
		return a;
	}

	function draw() {
		stage.innerHTML = '';
		bars = data.map(function (v) {
			var b = document.createElement('span');
			b.style.height = v + '%';
			stage.appendChild(b);
			return b;
		});
	}

	function reset() {
		cancel = true;
		data = rand(+sizeIn.value);
		sizeOut.textContent = sizeIn.value;
		statCmp.textContent = '0';
		statWr.textContent = '0';
		statStatus.textContent = 'Ready';
		draw();
	}

	/* ---- Generators: yield [type, i, j] events ---- */
	function* selection(a) {
		for (var i = 0; i < a.length - 1; i++) {
			var max = i;
			for (var j = i + 1; j < a.length; j++) {
				yield ['cmp', j, max];
				if (a[j] > a[max]) max = j;
			}
			if (max !== i) { var t = a[i]; a[i] = a[max]; a[max] = t; yield ['swap', i, max]; }
		}
	}
	function* insertion(a) {
		for (var i = 1; i < a.length; i++) {
			var key = a[i], j = i - 1;
			while (j >= 0) {
				yield ['cmp', j, j + 1];
				if (a[j] < key) { a[j + 1] = a[j]; yield ['set', j + 1]; j--; } else break;
			}
			a[j + 1] = key; yield ['set', j + 1];
		}
	}
	function* mergeSort(a, lo, hi) {
		if (lo >= hi) return;
		var mid = (lo + hi) >> 1;
		yield* mergeSort(a, lo, mid);
		yield* mergeSort(a, mid + 1, hi);
		var left = a.slice(lo, mid + 1), right = a.slice(mid + 1, hi + 1), i = 0, j = 0, k = lo;
		while (i < left.length && j < right.length) {
			yield ['cmp', lo + i, mid + 1 + j];
			a[k] = left[i] >= right[j] ? left[i++] : right[j++];
			yield ['set', k++];
		}
		while (i < left.length) { a[k] = left[i++]; yield ['set', k++]; }
		while (j < right.length) { a[k] = right[j++]; yield ['set', k++]; }
	}
	function* quickSort(a, lo, hi) {
		if (lo < hi) {
			var pivot = a[hi], i = lo - 1;
			for (var j = lo; j <= hi - 1; j++) {
				yield ['cmp', j, hi];
				if (a[j] > pivot) { i++; var t = a[i]; a[i] = a[j]; a[j] = t; yield ['swap', i, j]; }
			}
			var t2 = a[i + 1]; a[i + 1] = a[hi]; a[hi] = t2; yield ['swap', i + 1, hi];
			yield* quickSort(a, lo, i);
			yield* quickSort(a, i + 2, hi);
		}
	}
	var algos = {
		selection: function (a) { return selection(a); },
		insertion: function (a) { return insertion(a); },
		merge: function (a) { return mergeSort(a, 0, a.length - 1); },
		quick: function (a) { return quickSort(a, 0, a.length - 1); }
	};

	function clearMarks() {
		for (var i = 0; i < bars.length; i++) bars[i].className = '';
	}

	function run() {
		if (running) { cancel = true; return; }
		var arr = data.slice();
		var gen = algos[algoSel.value](arr);
		var cmp = 0, wr = 0;
		running = true; cancel = false;
		runBtn.innerHTML = '<i class="fas fa-stop"></i> Stop';
		statStatus.textContent = 'Sorting…';
		sizeIn.disabled = shuffleBtn.disabled = algoSel.disabled = true;

		function finish(done) {
			running = false;
			runBtn.innerHTML = '<i class="fas fa-play"></i> Sort';
			sizeIn.disabled = shuffleBtn.disabled = algoSel.disabled = false;
			clearMarks();
			if (done) {
				data = arr;
				bars.forEach(function (b) { b.className = 'is-done'; });
				statStatus.textContent = 'Sorted ✓';
			} else {
				statStatus.textContent = 'Stopped';
			}
		}

		(function step() {
			if (cancel) return finish(false);
			var steps = Math.max(1, Math.round(Math.pow(+speedIn.value, 2) / 8));
			clearMarks();
			for (var s = 0; s < steps; s++) {
				var ev = gen.next();
				if (ev.done) return finish(true);
				var e = ev.value;
				if (e[0] === 'cmp') {
					cmp++;
					bars[e[1]].className = 'is-cmp'; bars[e[2]].className = 'is-cmp';
				} else if (e[0] === 'swap') {
					wr += 2;
					bars[e[1]].style.height = arr[e[1]] + '%'; bars[e[2]].style.height = arr[e[2]] + '%';
					bars[e[1]].className = 'is-swap'; bars[e[2]].className = 'is-swap';
				} else {
					wr++;
					bars[e[1]].style.height = arr[e[1]] + '%';
					bars[e[1]].className = 'is-swap';
				}
			}
			statCmp.textContent = cmp.toLocaleString();
			statWr.textContent = wr.toLocaleString();
			setTimeout(step, 16);
		})();
	}

	sizeIn.addEventListener('input', reset);
	shuffleBtn.addEventListener('click', reset);
	runBtn.addEventListener('click', run);
	algoSel.addEventListener('change', function () { if (!running) { statStatus.textContent = 'Ready'; } });
	reset();
	cancel = false;

	/* ---- Live benchmark (no animation) ---- */
	var benchBtn = document.getElementById('bench-run');
	var benchSize = document.getElementById('bench-size');
	var benchBody = document.getElementById('bench-body');
	if (!benchBtn) return;

	function plain(name, a) {
		var c = 0, n = a.length, i, j, t;
		if (name === 'selection') {
			for (i = 0; i < n - 1; i++) {
				var m = i;
				for (j = i + 1; j < n; j++) { c++; if (a[j] > a[m]) m = j; }
				t = a[i]; a[i] = a[m]; a[m] = t;
			}
		} else if (name === 'insertion') {
			for (i = 1; i < n; i++) {
				var key = a[i]; j = i - 1;
				while (j >= 0) { c++; if (a[j] < key) { a[j + 1] = a[j]; j--; } else break; }
				a[j + 1] = key;
			}
		} else if (name === 'merge') {
			var tmp = new Array(n);
			(function ms(lo, hi) {
				if (lo >= hi) return;
				var mid = (lo + hi) >> 1;
				ms(lo, mid); ms(mid + 1, hi);
				var x = lo, y = mid + 1, k = lo;
				while (x <= mid && y <= hi) { c++; tmp[k++] = a[x] >= a[y] ? a[x++] : a[y++]; }
				while (x <= mid) tmp[k++] = a[x++];
				while (y <= hi) tmp[k++] = a[y++];
				for (k = lo; k <= hi; k++) a[k] = tmp[k];
			})(0, n - 1);
		} else {
			(function qs(lo, hi) {
				while (lo < hi) {
					var p = a[hi], q = lo - 1;
					for (var r = lo; r < hi; r++) { c++; if (a[r] > p) { q++; t = a[q]; a[q] = a[r]; a[r] = t; } }
					t = a[q + 1]; a[q + 1] = a[hi]; a[hi] = t;
					var pi = q + 1;
					if (pi - lo < hi - pi) { qs(lo, pi - 1); lo = pi + 1; } else { qs(pi + 1, hi); hi = pi - 1; }
				}
			})(0, n - 1);
		}
		return c;
	}

	benchBtn.addEventListener('click', function () {
		var n = +benchSize.value;
		var base = [];
		for (var i = 0; i < n; i++) base.push(1 + Math.floor(Math.random() * 2000000));
		benchBtn.disabled = true;
		benchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running…';
		benchBody.innerHTML = '';
		var names = [['selection', 'Selection sort', 'O(n²)'], ['insertion', 'Insertion sort', 'O(n²)'], ['merge', 'Merge sort', 'O(n log n)'], ['quick', 'Quick sort', 'O(n log n) avg']];
		var results = [];
		var idx = 0;
		(function next() {
			if (idx === names.length) {
				var max = Math.max.apply(null, results.map(function (r) { return r.ms; }));
				results.forEach(function (r) {
					var tr = document.createElement('tr');
					tr.innerHTML = '<td>' + r.label + '</td><td>' + r.big + '</td><td>' + r.cmp.toLocaleString() + '</td><td>' + r.ms.toFixed(2) + ' ms</td>' +
						'<td class="bench__bar"><span style="width:' + Math.max(2, (r.ms / max) * 100) + '%"></span></td>';
					benchBody.appendChild(tr);
				});
				benchBtn.disabled = false;
				benchBtn.innerHTML = '<i class="fas fa-redo"></i> Run again';
				return;
			}
			var a = base.slice();
			var t0 = performance.now();
			var c = plain(names[idx][0], a);
			var ms = performance.now() - t0;
			results.push({ label: names[idx][1], big: names[idx][2], cmp: c, ms: ms });
			idx++;
			setTimeout(next, 30);
		})();
	});
})();
