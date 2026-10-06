// Interactive research map: topics, sub-topics and the papers behind them.
// Layout and content live in research-map.yaml; paper details come from publications.bib.
(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let labelFont = "'Inter', sans-serif"; // replaced by `font:` from research-map.yaml
    const WOBBLE = 2.5; // how far nodes drift, in canvas units
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const measureCtx = document.createElement('canvas').getContext('2d');

    document.addEventListener('DOMContentLoaded', () => {
        const root = document.getElementById('research-map');
        if (!root) return;
        Promise.all([
            fetch('research-map.yaml').then(response => response.text()).then(text => jsyaml.load(text)),
            fetch('publications.bib').then(response => response.text()),
        ])
            .then(([data, bibtex]) => loadFont(root, data.font).then(() => buildMap(root, data, parseBibEntries(bibtex))))
            .catch(error => {
                console.error('Error building research map:', error);
                root.innerHTML = '<p>Could not load research map.</p>';
            });
    });

    // Labels are measured to wrap them, so the font must be loaded before drawing.
    function loadFont(root, family) {
        if (family) {
            labelFont = `'${family}', sans-serif`;
            root.style.setProperty('--rmap-font', labelFont);
        }
        if (!family || family === 'Inter') return document.fonts ? document.fonts.ready : Promise.resolve();
        return new Promise(resolve => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@400;700&display=swap`;
            link.onload = link.onerror = resolve;
            document.head.appendChild(link);
        })
            .then(() => document.fonts.load(`16px '${family}'`))
            .catch(() => {});
    }

    function buildMap(root, data, bib) {
        const [width, height] = data.canvas || [1000, 880];
        const nodes = data.nodes;
        const byId = new Map(nodes.map(n => [n.id, n]));

        nodes.forEach((n, i) => {
            n.related = new Set([n]);
            n.ox = n.oy = 0;
            n.phase = i * 2.4;
            n.period = 7000 + (i * 1237) % 4000;
            n.children = [];
            (n.papers || []).forEach(key => {
                if (!bib[key]) console.warn(`research map: "${key}" not found in publications.bib`);
            });
        });
        nodes.forEach(n => {
            const parent = byId.get(n.within);
            if (parent) { n.related.add(parent); parent.related.add(n); parent.children.push(n); }
        });

        const edges = [];
        (data.edges || []).forEach(edge => {
            const { from, to, bend = 0, via = null, top = false } =
                Array.isArray(edge) ? { from: edge[0], to: edge[1], bend: edge[2] } : edge;
            const a = byId.get(from), b = byId.get(to);
            if (!a || !b) { console.warn(`research map: edge ${from} -> ${to} has an unknown node`); return; }
            a.related.add(b);
            b.related.add(a);
            a.children.push(b);
            // `via` may be a single [x, y] or a list of one or two control points.
            const controls = via && (typeof via[0] === 'number' ? [via] : via);
            edges.push({ a, b, bend, controls, top });
        });

        // Each bubble collects its own papers plus everything below it; that count sets its size.
        nodes.forEach(n => {
            n.allPapers = collectPapers(n, bib);
            if (n.w === undefined && n.r === undefined) n.r = nodeRadius(n.allPapers.length);
        });

        root.innerHTML = `
            <div class="rmap-bar">
                <span class="rmap-hint">Hover a topic to trace its connections; click it for the papers.</span>
                <span class="rmap-legend"><span class="rmap-legend-wip"></span>in progress</span>
                <button type="button" class="rmap-expand" title="Expand map"><i class="fas fa-expand"></i></button>
            </div>
            <div class="rmap-body">
                <div class="rmap-canvas"></div>
                <div class="rmap-panel" aria-live="polite"></div>
            </div>`;
        const canvas = root.querySelector('.rmap-canvas');
        const panel = root.querySelector('.rmap-panel');
        const expandButton = root.querySelector('.rmap-expand');

        const svgEl = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Map of research topics' }, canvas);
        const defs = svg('defs', {}, svgEl);
        ['', '-on'].forEach(suffix => {
            const marker = svg('marker', {
                id: 'rmap-arrow' + suffix, viewBox: '0 0 10 10', refX: 8, refY: 5,
                markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
            }, defs);
            svg('path', { d: 'M0,1 L9,5 L0,9 z', class: 'rmap-arrowhead' + suffix }, marker);
        });
        const thumbLayer = svg('g', {}, svgEl);
        const edgeLayer = svg('g', {}, svgEl);
        const nodeLayer = svg('g', {}, svgEl);
        const topEdgeLayer = svg('g', {}, svgEl);
        const badgeLayer = svg('g', {}, svgEl);

        nodes.forEach(n => {
            if (n.image && n.thumb) {
                // A slightly tilted "photo card" peeking out from behind the bubble.
                const t = n.thumb, w = t.w || 140, h = t.h || w * 0.7, pad = 4;
                n.thumbEl = svg('g', { class: 'rmap-thumb' }, thumbLayer);
                const card = svg('g', { transform: `translate(${t.dx || 0},${t.dy || 0}) rotate(${t.rotate || 0})` }, n.thumbEl);
                svg('rect', { class: 'rmap-thumb-card', x: -w / 2 - pad, y: -h / 2 - pad, width: w + 2 * pad, height: h + 2 * pad, rx: 3 }, card);
                svg('image', { href: n.image, x: -w / 2, y: -h / 2, width: w, height: h, preserveAspectRatio: 'xMidYMid slice' }, card);
            }
            n.g = drawNode(n, nodeLayer);
            n.badgeEl = drawBadge(n, nodes, badgeLayer);
        });
        edges.forEach(e => {
            e.path = svg('path', { class: 'rmap-edge', 'marker-end': 'url(#rmap-arrow)' }, e.top ? topEdgeLayer : edgeLayer);
        });

        // ---------- Positions and gentle drift ----------
        function place() {
            nodes.forEach(n => {
                const transform = `translate(${n.x + n.ox},${n.y + n.oy})`;
                n.g.setAttribute('transform', transform);
                if (n.thumbEl) n.thumbEl.setAttribute('transform', transform);
                if (n.badgeEl) n.badgeEl.setAttribute('transform', `${transform} translate(${n.badgeAt[0]},${n.badgeAt[1]})`);
            });
            edges.forEach(e => e.path.setAttribute('d', edgePath(e)));
        }
        let frame = 0;
        function tick(now) {
            nodes.forEach(n => {
                const angle = (now / n.period) * 2 * Math.PI + n.phase;
                n.ox = WOBBLE * Math.sin(angle);
                n.oy = WOBBLE * Math.cos(angle * 0.8);
            });
            place();
            frame = requestAnimationFrame(tick);
        }
        place();
        if (!reducedMotion && 'IntersectionObserver' in window) {
            // Only animate while the map is on screen.
            new IntersectionObserver(([entry]) => {
                if (entry.isIntersecting && !frame) frame = requestAnimationFrame(tick);
                else if (!entry.isIntersecting && frame) { cancelAnimationFrame(frame); frame = 0; }
            }).observe(svgEl);
        }

        // ---------- Highlighting and selection ----------
        let selected = null;
        function highlight(n) {
            svgEl.classList.toggle('has-focus', !!n);
            nodes.forEach(m => {
                const on = !!n && n.related.has(m);
                m.g.classList.toggle('is-related', on);
                if (m.thumbEl) m.thumbEl.classList.toggle('is-related', on);
                if (m.badgeEl) m.badgeEl.classList.toggle('is-related', on);
            });
            edges.forEach(e => {
                const on = !!n && (e.a === n || e.b === n);
                e.path.classList.toggle('is-related', on);
                e.path.setAttribute('marker-end', `url(#rmap-arrow${on ? '-on' : ''})`);
            });
        }
        function select(n) {
            if (selected) selected.g.classList.remove('is-selected');
            selected = n;
            if (n) n.g.classList.add('is-selected');
            highlight(n);
            renderPanel(n);
        }
        nodes.forEach(n => {
            n.g.addEventListener('mouseenter', () => highlight(n));
            n.g.addEventListener('mouseleave', () => highlight(selected));
            n.g.addEventListener('focus', () => highlight(n));
            n.g.addEventListener('blur', () => highlight(selected));
            n.g.addEventListener('click', () => select(n));
            n.g.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(n); }
            });
        });
        svgEl.addEventListener('click', event => {
            if (!event.target.closest('.rmap-node')) select(null);
        });

        function renderPanel(n) {
            if (!n) {
                panel.innerHTML = '<p class="rmap-empty">Select a topic to see the related papers.</p>';
                return;
            }
            let html = `<div class="rmap-panel-title">
                <span class="rmap-swatch" style="background:${n.color}"></span>${plainLabel(n)}
                ${n.status === 'wip' ? '<span class="rmap-wip-tag">in progress</span>' : ''}</div>`;
            if (n.blurb) html += `<p class="rmap-blurb">${n.blurb}</p>`;
            if (n.image) html += `<img class="rmap-panel-img" src="${n.image}" alt="">`;
            html += n.allPapers.map(({ entry, owner }) =>
                renderPaper(entry, owner === n ? '' : plainLabel(owner))).join('');
            if (!n.allPapers.length && !n.links) {
                html += `<p class="rmap-empty">${n.status === 'wip' ? 'Work in progress, more soon.' : 'No paper linked yet.'}</p>`;
            }
            if (n.links) {
                html += '<div class="rmap-links">' +
                    n.links.map(link => `<a href="${link.url}" target="_blank" class="pub-link">[${link.text}]</a>`).join('') +
                    '</div>';
            }
            const others = [...n.related].filter(m => m !== n);
            if (others.length) {
                html += '<div class="rmap-related"><span>Connected:</span>' +
                    others.map(m => `<button type="button" class="rmap-chip" data-id="${m.id}">
                        <span class="rmap-swatch" style="background:${m.color}"></span>${plainLabel(m)}</button>`).join('') +
                    '</div>';
            }
            panel.innerHTML = html;
            panel.querySelectorAll('.rmap-chip').forEach(button =>
                button.addEventListener('click', () => select(byId.get(button.dataset.id))));
        }
        renderPanel(null);

        // ---------- Full-screen mode ----------
        function setExpanded(on) {
            root.classList.toggle('is-expanded', on);
            document.body.classList.toggle('rmap-lock', on);
            expandButton.innerHTML = `<i class="fas ${on ? 'fa-compress' : 'fa-expand'}"></i>`;
            expandButton.title = on ? 'Close (Esc)' : 'Expand map';
        }
        expandButton.addEventListener('click', () => setExpanded(!root.classList.contains('is-expanded')));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && root.classList.contains('is-expanded')) setExpanded(false);
        });
    }

    // ---------- Drawing ----------
    function drawNode(n, layer) {
        const isBox = n.w !== undefined;
        const fill = n.color || '#9bb7d4';
        const g = svg('g', {
            class: 'rmap-node' + (n.status === 'wip' ? ' is-wip' : ''),
            tabindex: 0, role: 'button', 'aria-label': plainLabel(n),
        }, layer);
        const shape = isBox
            ? { tag: 'rect', attrs: { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: 10 } }
            : { tag: 'circle', attrs: { r: n.r } };
        svg(shape.tag, { ...shape.attrs, fill, stroke: n.stroke || shade(fill, 0.28), class: 'rmap-shape' }, g);

        const maxWidth = isBox ? n.w - 18 : n.r * 1.7;
        const maxHeight = isBox ? n.h - 12 : n.r * 1.5;
        const ink = luminance(fill) > 0.45 ? '#1f2d3a' : '#ffffff';
        drawLabel(g, n.label, n.font || (isBox ? 13 : fontSize(n.r)), maxWidth, maxHeight, ink);

        return g;
    }

    // Paper-count badge on the outline, at the first spot not covered by another bubble.
    // Badges live in their own top layer so overlapping bubbles never hide them.
    function drawBadge(n, nodes, layer) {
        const count = n.allPapers.length;
        if (!count) return null;
        const isBox = n.w !== undefined;
        const spots = isBox
            ? [[n.w / 2 - 2, -n.h / 2 + 2], [-n.w / 2 + 2, -n.h / 2 + 2]]
            : [-45, -65, -25, -90, -115, -135, 0, -160, 180, 45, 135, 90].map(deg => {
                const a = deg * Math.PI / 180;
                return [n.r * Math.cos(a), n.r * Math.sin(a)];
            });
        const covered = ([dx, dy]) => nodes.some(m => m !== n && m.r !== undefined &&
            Math.hypot(n.x + dx - m.x, n.y + dy - m.y) < m.r + 10);
        n.badgeAt = spots.find(spot => !covered(spot)) || spots[0];
        const badge = svg('g', { class: 'rmap-badge' }, layer);
        svg('circle', { r: 9 }, badge);
        svg('text', { 'text-anchor': 'middle', dy: '0.35em', 'font-size': 10 }, badge).textContent = count;
        return badge;
    }

    function drawLabel(g, label, startSize, maxWidth, maxHeight, ink) {
        let size = startSize, lines;
        for (; size > 10; size -= 0.5) {
            lines = wrapText(label, maxWidth, size);
            const widest = Math.max(...lines.map(line => textWidth(line, size)));
            if (widest <= maxWidth && lines.length * size * 1.2 <= maxHeight) break;
        }
        const text = svg('text', { 'text-anchor': 'middle', 'font-size': size, fill: ink, class: 'rmap-label' }, g);
        lines.forEach((line, i) => {
            svg('tspan', { x: 0, y: (i - (lines.length - 1) / 2) * size * 1.2, dy: '0.35em' }, text).textContent = line;
        });
        return text;
    }

    function wrapText(label, maxWidth, size) {
        const lines = [];
        String(label).split('\n').forEach(paragraph => {
            let line = '';
            paragraph.split(/\s+/).forEach(word => {
                // Long hyphenated words may break after the hyphen ("Info-" / "geometric").
                word.split(/(?<=-)/).forEach((part, i) => {
                    const candidate = line ? line + (i ? '' : ' ') + part : part;
                    if (line && textWidth(candidate, size) > maxWidth) { lines.push(line); line = part; }
                    else line = candidate;
                });
            });
            lines.push(line);
        });
        return lines;
    }

    function textWidth(s, size) {
        measureCtx.font = `${size}px ${labelFont}`;
        return measureCtx.measureText(s).width;
    }

    function edgePath(e) {
        const ax = e.a.x + e.a.ox, ay = e.a.y + e.a.oy;
        const bx = e.b.x + e.b.ox, by = e.b.y + e.b.oy;
        if (e.controls) {
            const first = e.controls[0], last = e.controls[e.controls.length - 1];
            const [sx, sy] = boundaryPoint(e.a, ax, ay, first[0], first[1], 2);
            const [tx, ty] = boundaryPoint(e.b, bx, by, last[0], last[1], 4);
            const command = e.controls.length > 1 ? 'C' : 'Q';
            return `M${sx},${sy} ${command}${e.controls.map(p => p.join(',')).join(' ')} ${tx},${ty}`;
        }
        // Control point sits off the midpoint, perpendicular to the edge.
        const cx = (ax + bx) / 2 - (by - ay) * e.bend;
        const cy = (ay + by) / 2 + (bx - ax) * e.bend;
        const [sx, sy] = boundaryPoint(e.a, ax, ay, cx, cy, 2);
        const [tx, ty] = boundaryPoint(e.b, bx, by, cx, cy, 4);
        return e.bend ? `M${sx},${sy} Q${cx},${cy} ${tx},${ty}` : `M${sx},${sy} L${tx},${ty}`;
    }

    // Point on the node's outline in the direction of (tx, ty), pushed out by `gap`.
    function boundaryPoint(n, x, y, tx, ty, gap) {
        const length = Math.hypot(tx - x, ty - y) || 1;
        const ux = (tx - x) / length, uy = (ty - y) / length;
        const distance = n.w !== undefined
            ? Math.min(n.w / 2 / Math.abs(ux || 1e-9), n.h / 2 / Math.abs(uy || 1e-9))
            : n.r;
        return [x + ux * (distance + gap), y + uy * (distance + gap)];
    }

    // ---------- Sizes ----------
    // Bubble radius grows with the number of papers it covers, up to a cap.
    function nodeRadius(paperCount) {
        return Math.min(120, 36 + 20 * Math.sqrt(paperCount));
    }

    function fontSize(radius) {
        return clamp(radius * 0.22 + 3, 11, 28);
    }

    // ---------- Papers ----------
    // Papers of a node and of every node below it, newest first, each tagged with the node listing it.
    function collectPapers(root, bib) {
        const found = new Map(), seen = new Set();
        (function visit(n) {
            if (seen.has(n)) return;
            seen.add(n);
            (n.papers || []).forEach(key => {
                if (bib[key] && !found.has(key)) found.set(key, { entry: bib[key], owner: n });
            });
            n.children.forEach(visit);
        })(root);
        return [...found.values()].sort((a, b) =>
            (b.entry.year || 0) - (a.entry.year || 0) || (parseFloat(b.entry.impact) || 0) - (parseFloat(a.entry.impact) || 0));
    }

    function renderPaper(pub, subtopic) {
        const venue = pub.journal || pub.booktitle || (pub.eprint ? 'arXiv preprint' : '') || pub.publisher || '';
        let links = '';
        if (pub.url) links += ` <a href="${pub.url}" target="_blank" class="pub-link">[PDF]</a>`;
        if (pub.doi) links += ` <a href="https://doi.org/${pub.doi}" target="_blank" class="pub-link">[DOI]</a>`;
        return `<div class="publication">
            <div class="pub-title">${cleanTex(pub.title)}</div>
            <div class="pub-authors">${formatAuthors(pub.author || '')}</div>
            <div class="pub-venue-links"><span class="pub-venue">${cleanTex(venue)} (${pub.year})</span>${links}</div>
            ${subtopic ? `<div class="rmap-subtopic">in ${subtopic}</div>` : ''}
        </div>`;
    }

    function formatAuthors(authorField) {
        let names = cleanTex(authorField).split(/\s+and\s+/).map(name => name.trim());
        const me = names.findIndex(name => /Zakhar,?\s*Shumaylov/i.test(name));
        if (names.length > 8) {
            const shortList = names.slice(0, 4);
            if (me >= 4) shortList.push('…', names[me]);
            names = [...shortList, 'et al.'];
        }
        return names.join(', ')
            .replace(/, et al\.$/, ' et al.')
            .replace(/Zakhar,?\s*Shumaylov/gi, '<span class="author-highlight">ZS</span>');
    }

    function cleanTex(s) {
        return String(s || '').replace(/\\text(bf|it)\{([^}]*)\}/g, '$2').replace(/[{}]/g, '');
    }

    function plainLabel(n) {
        return String(n.label).replace(/-\n/g, '').replace(/\n/g, ' ');
    }

    // Map of bib key -> fields. Handles nested braces and keys on their own line.
    function parseBibEntries(bibtex) {
        const entries = {};
        const head = /@\w+\s*\{\s*([^,\s]+)\s*,/g;
        let match;
        while ((match = head.exec(bibtex))) {
            let i = head.lastIndex, depth = 1;
            const start = i;
            while (i < bibtex.length && depth > 0) {
                if (bibtex[i] === '{') depth++;
                else if (bibtex[i] === '}') depth--;
                i++;
            }
            entries[match[1]] = parseBibFields(bibtex.slice(start, i - 1));
            head.lastIndex = i;
        }
        return entries;
    }

    function parseBibFields(body) {
        const fields = {};
        const name = /(\w+)\s*=\s*/g;
        let match;
        while ((match = name.exec(body))) {
            let i = name.lastIndex, value;
            if (body[i] === '{') {
                let depth = 0, j = i;
                do {
                    if (body[j] === '{') depth++;
                    else if (body[j] === '}') depth--;
                    j++;
                } while (depth > 0 && j < body.length);
                value = body.slice(i + 1, j - 1);
                name.lastIndex = j;
            } else if (body[i] === '"') {
                const j = body.indexOf('"', i + 1);
                value = body.slice(i + 1, j);
                name.lastIndex = j + 1;
            } else {
                const rest = body.slice(i).search(/[,\n]/);
                const j = rest < 0 ? body.length : i + rest;
                value = body.slice(i, j);
                name.lastIndex = j;
            }
            fields[match[1].toLowerCase()] = value.trim();
        }
        return fields;
    }

    // ---------- Small helpers ----------
    function svg(tag, attrs, parent) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const key in attrs) el.setAttribute(key, attrs[key]);
        if (parent) parent.appendChild(el);
        return el;
    }

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    function hexToRgb(hex) {
        const h = hex.replace('#', '');
        const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
    }

    function shade(hex, amount) {
        return '#' + hexToRgb(hex).map(c => Math.round(c * (1 - amount)).toString(16).padStart(2, '0')).join('');
    }

    function luminance(hex) {
        const [r, g, b] = hexToRgb(hex).map(c => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
})();
