//! Force-directed layout for the graph view.
//!
//! The model is the one Obsidian's graph worker (`sim.js`) runs, which is
//! d3-force with these forces applied each tick, in order:
//!
//! 1. **Center** — `forceX(0)` and `forceY(0)`: `v += (0 − p) · center · α`.
//! 2. **Link** — d3's link force: each edge pulls its ends toward
//!    `link_distance`, with strength `link · 1/min(degree(s), degree(t))` and
//!    the correction split by relative degree.
//! 3. **Repel** — many-body charge `−repel` per node (at least −1), Barnes–Hut
//!    approximated with θ = 0.9, minimum distance 30.
//! 4. **Collide** — radius 60, strength 0.5 (a sorted uniform grid here
//!    instead of d3's quadtree; same pairs, same response).
//!
//! then velocities decay (`v ·= 0.6`) and positions integrate. `α` starts at
//! 1 and decays toward `alpha_target` by `1 − 0.001^(1/300)` per tick; the
//! simulation is at rest below 0.001. Pinned nodes keep their position and
//! have zero velocity.
//!
//! [`ForceParams`] takes the four sliders exactly as `graph.json` stores
//! them and maps them the way the settings panel does: center and link
//! strength through `(0.01^(1−v) − 0.01)/0.99`, repel as `v³`, distance
//! as-is. The defaults are Obsidian's.
//!
//! Positions are `f32`, stored interleaved so [`ForceLayout::positions`]
//! hands the renderer `[x0, y0, x1, y1, …]` without copying.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The graph settings' "Forces" sliders, in `graph.json` units.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ForceParams {
    /// Slider 0–1 (default ≈ 0.5187, i.e. a force of 0.1).
    pub center_strength: f32,
    /// Slider 0–20 (default 10, i.e. a charge of −1000).
    pub repel_strength: f32,
    /// Slider 0–1 (default 1).
    pub link_strength: f32,
    /// 30–500 (default 250).
    pub link_distance: f32,
}

impl Default for ForceParams {
    fn default() -> Self {
        ForceParams {
            center_strength: 0.518_713_25,
            repel_strength: 10.0,
            link_strength: 1.0,
            link_distance: 250.0,
        }
    }
}

/// Slider → force mapping (`c0` in the app).
fn log_slider(v: f32) -> f32 {
    let t = 0.01f32;
    (t.powf(1.0 - v.clamp(0.0, 1.0)) - t) / (1.0 - t)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Physics {
    center: f32,
    charge: f32,
    link: f32,
    distance: f32,
}

impl ForceParams {
    fn physics(&self) -> Physics {
        let repel = self.repel_strength.powi(3);
        Physics {
            center: log_slider(self.center_strength),
            charge: if repel.abs() < 1.0 { -1.0 } else { -repel },
            link: log_slider(self.link_strength),
            distance: self.link_distance,
        }
    }
}

const THETA2: f32 = 0.81;
const DISTANCE_MIN2: f32 = 900.0;
const VELOCITY_KEEP: f32 = 0.6;
const ALPHA_MIN: f32 = 0.001;
const COLLIDE_RADIUS: f32 = 60.0;
const COLLIDE_STRENGTH: f32 = 0.5;
const LEAF_SIZE: usize = 16;
const MAX_DEPTH: u32 = 20;
const NONE: u32 = u32::MAX;

#[derive(Clone, Copy, Debug)]
struct Cell {
    cx: f32,
    cy: f32,
    /// Number of bodies (all bodies carry the same charge).
    count: f32,
    /// size^2 / theta^2: the cell counts as far beyond this squared distance.
    far2: f32,
    children: [u32; 4],
    /// Leaf body range in `perm` (`lo == hi` for internal cells).
    lo: u32,
    hi: u32,
}

pub struct ForceLayout {
    n: usize,
    ids: Vec<String>,
    pos: Vec<f32>,
    vel: Vec<f32>,
    pinned: Vec<Option<(f32, f32)>>,
    edges: Vec<[u32; 2]>,
    link_bias: Vec<f32>,
    link_scale: Vec<f32>,
    params: ForceParams,
    phys: Physics,
    alpha: f32,
    alpha_target: f32,
    alpha_decay: f32,
    rng: u32,
    // Scratch buffers reused across ticks.
    cells: Vec<Cell>,
    perm: Vec<u32>,
    stack: Vec<u32>,
    grid: Vec<(i64, u32)>,
    runs: Vec<(i64, u32, u32)>,
    sorted: Vec<f32>,
}

impl ForceLayout {
    /// A fresh layout for `n_nodes` nodes (ids `"0"`, `"1"`, …).
    pub fn new(n_nodes: usize, edges: &[(u32, u32)], params: ForceParams) -> Self {
        let ids = (0..n_nodes).map(|i| i.to_string()).collect();
        Self::with_ids(ids, edges, params)
    }

    /// A fresh layout with node ids (used to carry positions across
    /// [`ForceLayout::set_graph`]).
    pub fn with_ids(ids: Vec<String>, edges: &[(u32, u32)], params: ForceParams) -> Self {
        let mut l = ForceLayout {
            n: 0,
            ids: Vec::new(),
            pos: Vec::new(),
            vel: Vec::new(),
            pinned: Vec::new(),
            edges: Vec::new(),
            link_bias: Vec::new(),
            link_scale: Vec::new(),
            params,
            phys: params.physics(),
            alpha: 1.0,
            alpha_target: 0.0,
            alpha_decay: 1.0 - ALPHA_MIN.powf(1.0 / 300.0),
            rng: 1,
            cells: Vec::new(),
            perm: Vec::new(),
            stack: Vec::new(),
            grid: Vec::new(),
            runs: Vec::new(),
            sorted: Vec::new(),
        };
        l.set_graph(ids, edges);
        l.alpha = 1.0;
        l
    }

    pub fn node_count(&self) -> usize {
        self.n
    }

    pub fn ids(&self) -> &[String] {
        &self.ids
    }

    /// `[x0, y0, x1, y1, …]`.
    pub fn positions(&self) -> &[f32] {
        &self.pos
    }

    pub fn alpha(&self) -> f32 {
        self.alpha
    }

    /// Whether ticks still move anything.
    pub fn is_running(&self) -> bool {
        self.alpha >= ALPHA_MIN || self.alpha_target >= ALPHA_MIN
    }

    pub fn params(&self) -> ForceParams {
        self.params
    }

    /// Changes the forces and wakes the simulation, as moving a slider does.
    pub fn set_params(&mut self, params: ForceParams) {
        self.params = params;
        self.phys = params.physics();
        self.reheat(0.3);
    }

    /// Raises alpha to at least `alpha`.
    pub fn reheat(&mut self, alpha: f32) {
        if self.alpha < alpha {
            self.alpha = alpha;
        }
    }

    /// Dragging sets a target (e.g. 0.3) so the graph stays live; release
    /// sets it back to 0.
    pub fn set_alpha_target(&mut self, target: f32) {
        self.alpha_target = target;
    }

    /// Fixes a node at `(x, y)` (a drag).
    pub fn pin(&mut self, node: usize, x: f32, y: f32) {
        if node < self.n {
            self.pinned[node] = Some((x, y));
            self.pos[node * 2] = x;
            self.pos[node * 2 + 1] = y;
            self.vel[node * 2] = 0.0;
            self.vel[node * 2 + 1] = 0.0;
        }
    }

    pub fn unpin(&mut self, node: usize) {
        if node < self.n {
            self.pinned[node] = None;
        }
    }

    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.ids.iter().position(|x| x == id)
    }

    /// Replaces the graph, keeping position and velocity of every node whose
    /// id survives (warm restart). New nodes start next to a placed
    /// neighbor, or on a phyllotaxis spiral around the current centroid.
    /// Alpha is raised to 0.3 when a layout already existed.
    pub fn set_graph(&mut self, ids: Vec<String>, edges: &[(u32, u32)]) {
        let had_nodes = self.n > 0;
        let old: HashMap<&str, usize> = self
            .ids
            .iter()
            .enumerate()
            .map(|(i, s)| (s.as_str(), i))
            .collect();
        let n = ids.len();
        let mut pos = vec![0f32; n * 2];
        let mut vel = vec![0f32; n * 2];
        let mut pinned = vec![None; n];
        let mut placed = vec![false; n];
        let (mut sx, mut sy, mut sc) = (0f32, 0f32, 0f32);
        for (i, id) in ids.iter().enumerate() {
            if let Some(&j) = old.get(id.as_str()) {
                pos[i * 2] = self.pos[j * 2];
                pos[i * 2 + 1] = self.pos[j * 2 + 1];
                vel[i * 2] = self.vel[j * 2];
                vel[i * 2 + 1] = self.vel[j * 2 + 1];
                pinned[i] = self.pinned[j];
                placed[i] = true;
                sx += pos[i * 2];
                sy += pos[i * 2 + 1];
                sc += 1.0;
            }
        }
        let (cx, cy) = if sc > 0.0 {
            (sx / sc, sy / sc)
        } else {
            (0.0, 0.0)
        };
        let edges: Vec<[u32; 2]> = edges
            .iter()
            .filter(|(a, b)| (*a as usize) < n && (*b as usize) < n)
            .map(|&(a, b)| [a, b])
            .collect();
        // Place new nodes: next to an already placed neighbor if any.
        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
        for e in &edges {
            adj[e[0] as usize].push(e[1]);
            adj[e[1] as usize].push(e[0]);
        }
        let mut spiral = 0usize;
        for i in 0..n {
            if placed[i] {
                continue;
            }
            let neighbor = adj[i].iter().find(|&&j| placed[j as usize]);
            let (x, y) = match neighbor {
                Some(&j) => {
                    let a = self.next_random() * std::f32::consts::TAU;
                    let r = self.phys.distance * 0.5;
                    (
                        pos[j as usize * 2] + r * a.cos(),
                        pos[j as usize * 2 + 1] + r * a.sin(),
                    )
                }
                None => {
                    let k = spiral as f32;
                    spiral += 1;
                    let radius = 10.0 * (0.5 + k).sqrt();
                    let angle = k * std::f32::consts::PI * (3.0 - 5f32.sqrt());
                    (cx + radius * angle.cos(), cy + radius * angle.sin())
                }
            };
            pos[i * 2] = x;
            pos[i * 2 + 1] = y;
            placed[i] = true;
        }
        // Link force constants (d3 `forceLink` initialize).
        let mut count = vec![0f32; n];
        for e in &edges {
            count[e[0] as usize] += 1.0;
            count[e[1] as usize] += 1.0;
        }
        self.link_bias = edges
            .iter()
            .map(|e| count[e[0] as usize] / (count[e[0] as usize] + count[e[1] as usize]))
            .collect();
        self.link_scale = edges
            .iter()
            .map(|e| 1.0 / count[e[0] as usize].min(count[e[1] as usize]))
            .collect();
        self.n = n;
        self.ids = ids;
        self.pos = pos;
        self.vel = vel;
        self.pinned = pinned;
        self.edges = edges;
        if had_nodes {
            self.reheat(0.3);
        }
    }

    /// d3's LCG, used for jiggle.
    fn next_random(&mut self) -> f32 {
        self.rng = self.rng.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.rng as f32 / 4_294_967_296.0
    }

    fn jiggle(&mut self) -> f32 {
        (self.next_random() - 0.5) * 1e-6
    }

    /// Runs up to `iterations` ticks; returns whether the simulation is still
    /// running.
    pub fn step(&mut self, iterations: u32) -> bool {
        for _ in 0..iterations {
            if !self.is_running() {
                break;
            }
            self.tick();
        }
        self.is_running()
    }

    /// One tick, regardless of alpha.
    pub fn tick(&mut self) {
        self.alpha += (self.alpha_target - self.alpha) * self.alpha_decay;
        let alpha = self.alpha;
        if self.n == 0 {
            return;
        }
        self.apply_center(alpha);
        self.apply_links(alpha);
        self.apply_charge(alpha);
        self.apply_collide();
        for i in 0..self.n {
            match self.pinned[i] {
                Some((x, y)) => {
                    self.pos[i * 2] = x;
                    self.pos[i * 2 + 1] = y;
                    self.vel[i * 2] = 0.0;
                    self.vel[i * 2 + 1] = 0.0;
                }
                None => {
                    self.vel[i * 2] *= VELOCITY_KEEP;
                    self.vel[i * 2 + 1] *= VELOCITY_KEEP;
                    self.pos[i * 2] += self.vel[i * 2];
                    self.pos[i * 2 + 1] += self.vel[i * 2 + 1];
                }
            }
        }
    }

    #[doc(hidden)]
    #[cfg(not(target_arch = "wasm32"))]
    pub fn profile_tick(&mut self) -> [f64; 5] {
        let a = self.alpha.max(0.05);
        let t = std::time::Instant::now();
        self.apply_center(a);
        let c = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        self.apply_links(a);
        let l = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        self.build_tree();
        let b = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        self.apply_charge(a);
        let ch = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        self.apply_collide();
        let co = t.elapsed().as_secs_f64() * 1e3;
        [c, l, b, ch, co]
    }

    fn apply_center(&mut self, alpha: f32) {
        let k = self.phys.center * alpha;
        for i in 0..self.n * 2 {
            self.vel[i] -= self.pos[i] * k;
        }
    }

    fn apply_links(&mut self, alpha: f32) {
        let strength = self.phys.link;
        let distance = self.phys.distance;
        for k in 0..self.edges.len() {
            let [s, t] = self.edges[k];
            let (s, t) = (s as usize, t as usize);
            let mut dx = self.pos[t * 2] + self.vel[t * 2] - self.pos[s * 2] - self.vel[s * 2];
            let mut dy = self.pos[t * 2 + 1] + self.vel[t * 2 + 1]
                - self.pos[s * 2 + 1]
                - self.vel[s * 2 + 1];
            if dx == 0.0 {
                dx = self.jiggle();
            }
            if dy == 0.0 {
                dy = self.jiggle();
            }
            let len = (dx * dx + dy * dy).sqrt();
            let l = (len - distance) / len * alpha * strength * self.link_scale[k];
            dx *= l;
            dy *= l;
            let b = self.link_bias[k];
            self.vel[t * 2] -= dx * b;
            self.vel[t * 2 + 1] -= dy * b;
            self.vel[s * 2] += dx * (1.0 - b);
            self.vel[s * 2 + 1] += dy * (1.0 - b);
        }
    }

    fn build_tree(&mut self) -> u32 {
        self.cells.clear();
        self.perm.clear();
        self.perm.extend(0..self.n as u32);
        let (mut x0, mut y0, mut x1, mut y1) = (
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        );
        for i in 0..self.n {
            let (x, y) = (self.pos[i * 2], self.pos[i * 2 + 1]);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let size = (x1 - x0).max(y1 - y0).max(1.0) * 1.0001;
        let mut perm = std::mem::take(&mut self.perm);
        let root = build(
            &mut self.cells,
            &self.pos,
            &mut perm,
            0,
            self.n,
            x0,
            y0,
            size,
            0,
        );
        self.perm = perm;
        root
    }

    fn apply_charge(&mut self, alpha: f32) {
        let root = self.build_tree();
        let ca = self.phys.charge * alpha;
        let n = self.n;
        // Bodies copied in tree order, so every leaf's bodies are contiguous.
        let mut sorted = std::mem::take(&mut self.sorted);
        sorted.clear();
        for &p in &self.perm {
            sorted.push(self.pos[p as usize * 2]);
            sorted.push(self.pos[p as usize * 2 + 1]);
        }
        let cells = std::mem::take(&mut self.cells);
        let mut stack = std::mem::take(&mut self.stack);
        for k in 0..n {
            let (xi, yi) = (sorted[k * 2], sorted[k * 2 + 1]);
            let (mut fx, mut fy) = (0f32, 0f32);
            stack.clear();
            stack.push(root);
            while let Some(ci) = stack.pop() {
                let c = &cells[ci as usize];
                let dx = c.cx - xi;
                let dy = c.cy - yi;
                let mut l = dx * dx + dy * dy;
                if c.far2 < l {
                    // Far enough: the whole cell acts as one body.
                    if l < DISTANCE_MIN2 {
                        l = (DISTANCE_MIN2 * l).sqrt();
                    }
                    let w = ca * c.count / l;
                    fx += dx * w;
                    fy += dy * w;
                } else if c.lo != c.hi {
                    let (lo, hi) = (c.lo as usize, c.hi as usize);
                    let (mut lx, mut ly) = (0f32, 0f32);
                    let mut coincident = false;
                    for m in lo..hi {
                        let dx = sorted[m * 2] - xi;
                        let dy = sorted[m * 2 + 1] - yi;
                        let l = dx * dx + dy * dy;
                        // Branch-free so the loop vectorizes; `l == 0`
                        // (the body itself, or an exact duplicate) adds 0.
                        let l = if l < DISTANCE_MIN2 {
                            (DISTANCE_MIN2 * l).sqrt()
                        } else {
                            l
                        };
                        let w = if l > 0.0 { ca / l } else { 0.0 };
                        coincident |= l == 0.0 && m != k;
                        lx += dx * w;
                        ly += dy * w;
                    }
                    fx += lx;
                    fy += ly;
                    if coincident {
                        // d3 jiggles exact overlaps apart.
                        for m in lo..hi {
                            if m != k && sorted[m * 2] == xi && sorted[m * 2 + 1] == yi {
                                let (dx, dy) = (self.jiggle(), self.jiggle());
                                let l = (DISTANCE_MIN2 * (dx * dx + dy * dy)).sqrt();
                                fx += dx * ca / l;
                                fy += dy * ca / l;
                            }
                        }
                    }
                } else {
                    for &ch in &c.children {
                        if ch != NONE {
                            stack.push(ch);
                        }
                    }
                }
            }
            let i = self.perm[k] as usize;
            self.vel[i * 2] += fx;
            self.vel[i * 2 + 1] += fy;
        }
        self.cells = cells;
        self.stack = stack;
        self.sorted = sorted;
    }

    /// Collision response for pairs closer than two radii. Nodes are binned
    /// into a grid with cell size `2r` (sorted by packed cell key); each
    /// occupied cell is compared with itself and its four forward
    /// neighbours, found with a pointer that only moves forward.
    fn apply_collide(&mut self) {
        const OFF: i64 = 1 << 30;
        let r = COLLIDE_RADIUS * 2.0;
        let r2 = r * r;
        let cell_of = |v: f32| -> i64 { ((v / r).floor() as i64).clamp(-OFF + 2, OFF - 2) + OFF };
        let mut grid = std::mem::take(&mut self.grid);
        grid.clear();
        for i in 0..self.n {
            let cx = cell_of(self.pos[i * 2] + self.vel[i * 2]);
            let cy = cell_of(self.pos[i * 2 + 1] + self.vel[i * 2 + 1]);
            grid.push(((cx << 32) | cy, i as u32));
        }
        grid.sort_unstable();
        let mut runs = std::mem::take(&mut self.runs);
        runs.clear();
        let mut s = 0;
        while s < grid.len() {
            let mut e = s + 1;
            while e < grid.len() && grid[e].0 == grid[s].0 {
                e += 1;
            }
            runs.push((grid[s].0, s as u32, e as u32));
            s = e;
        }
        let mut p = 0usize;
        for ri in 0..runs.len() {
            let (key, s, e) = runs[ri];
            for a in s..e {
                for b in a + 1..e {
                    self.collide_pair(grid[a as usize].1, grid[b as usize].1, r, r2);
                }
            }
            let mut others = [usize::MAX; 4];
            if ri + 1 < runs.len() && runs[ri + 1].0 == key + 1 {
                others[0] = ri + 1;
            }
            let next_col = key + (1 << 32);
            while p < runs.len() && runs[p].0 < next_col - 1 {
                p += 1;
            }
            let mut q = p;
            let mut slot = 1;
            while q < runs.len() && runs[q].0 <= next_col + 1 {
                others[slot] = q;
                slot += 1;
                q += 1;
            }
            for &o in others.iter().filter(|&&o| o != usize::MAX) {
                let (_, s2, e2) = runs[o];
                for a in s..e {
                    for b in s2..e2 {
                        self.collide_pair(grid[a as usize].1, grid[b as usize].1, r, r2);
                    }
                }
            }
        }
        self.grid = grid;
        self.runs = runs;
    }

    #[inline]
    fn collide_pair(&mut self, a: u32, b: u32, r: f32, r2: f32) {
        let (a, b) = (a as usize, b as usize);
        let mut dx = self.pos[a * 2] + self.vel[a * 2] - self.pos[b * 2] - self.vel[b * 2];
        let mut dy =
            self.pos[a * 2 + 1] + self.vel[a * 2 + 1] - self.pos[b * 2 + 1] - self.vel[b * 2 + 1];
        let mut l = dx * dx + dy * dy;
        if l >= r2 {
            return;
        }
        if dx == 0.0 {
            dx = self.jiggle();
            l += dx * dx;
        }
        if dy == 0.0 {
            dy = self.jiggle();
            l += dy * dy;
        }
        let d = l.sqrt();
        let k = (r - d) / d * COLLIDE_STRENGTH * 0.5;
        self.vel[a * 2] += dx * k;
        self.vel[a * 2 + 1] += dy * k;
        self.vel[b * 2] -= dx * k;
        self.vel[b * 2 + 1] -= dy * k;
    }
}

/// Builds a quadtree cell over `perm[lo..hi]` inside the square at
/// `(x0, y0)` with side `size`, partitioning `perm` in place.
#[allow(clippy::too_many_arguments)]
fn build(
    cells: &mut Vec<Cell>,
    pos: &[f32],
    perm: &mut [u32],
    lo: usize,
    hi: usize,
    x0: f32,
    y0: f32,
    size: f32,
    depth: u32,
) -> u32 {
    let idx = cells.len() as u32;
    let count = (hi - lo) as f32;
    let (mut sx, mut sy) = (0f32, 0f32);
    for &p in &perm[lo..hi] {
        sx += pos[p as usize * 2];
        sy += pos[p as usize * 2 + 1];
    }
    let (cx, cy) = if hi > lo {
        (sx / count, sy / count)
    } else {
        (0.0, 0.0)
    };
    cells.push(Cell {
        cx,
        cy,
        count,
        far2: size * size / THETA2,
        children: [NONE; 4],
        lo: lo as u32,
        hi: hi as u32,
    });
    if hi - lo <= LEAF_SIZE || depth >= MAX_DEPTH {
        return idx;
    }
    let half = size / 2.0;
    let (mx, my) = (x0 + half, y0 + half);
    // Partition by y, then each half by x: quadrants 0 (top-left), 1
    // (top-right), 2 (bottom-left), 3 (bottom-right).
    let split_y = partition(perm, lo, hi, |p| pos[p as usize * 2 + 1] < my);
    let split_x_top = partition(perm, lo, split_y, |p| pos[p as usize * 2] < mx);
    let split_x_bottom = partition(perm, split_y, hi, |p| pos[p as usize * 2] < mx);
    let ranges = [
        (lo, split_x_top, x0, y0),
        (split_x_top, split_y, mx, y0),
        (split_y, split_x_bottom, x0, my),
        (split_x_bottom, hi, mx, my),
    ];
    let mut children = [NONE; 4];
    for (q, &(a, b, qx, qy)) in ranges.iter().enumerate() {
        if b > a {
            children[q] = build(cells, pos, perm, a, b, qx, qy, half, depth + 1);
        }
    }
    let c = &mut cells[idx as usize];
    c.children = children;
    c.lo = 0;
    c.hi = 0;
    idx
}

fn partition(perm: &mut [u32], lo: usize, hi: usize, pred: impl Fn(u32) -> bool) -> usize {
    let mut i = lo;
    for j in lo..hi {
        if pred(perm[j]) {
            perm.swap(i, j);
            i += 1;
        }
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dist(l: &ForceLayout, a: usize, b: usize) -> f32 {
        let p = l.positions();
        ((p[a * 2] - p[b * 2]).powi(2) + (p[a * 2 + 1] - p[b * 2 + 1]).powi(2)).sqrt()
    }

    #[test]
    fn default_sliders_map_to_obsidian_forces() {
        let p = ForceParams::default().physics();
        assert!((p.center - 0.1).abs() < 1e-3, "{}", p.center);
        assert_eq!(p.charge, -1000.0);
        assert!((p.link - 1.0).abs() < 1e-6);
        assert_eq!(p.distance, 250.0);
        let weak = ForceParams {
            repel_strength: 0.5,
            ..Default::default()
        }
        .physics();
        assert_eq!(weak.charge, -1.0);
    }

    #[test]
    fn two_linked_nodes_settle_near_link_distance() {
        let mut l = ForceLayout::new(
            2,
            &[(0, 1)],
            ForceParams {
                repel_strength: 0.0,
                center_strength: 0.0,
                ..Default::default()
            },
        );
        for _ in 0..600 {
            l.tick();
        }
        let d = dist(&l, 0, 1);
        assert!((d - 250.0).abs() < 15.0, "distance {d}");
    }

    #[test]
    fn repel_separates_unlinked_nodes_and_stops() {
        let mut l = ForceLayout::new(50, &[], ForceParams::default());
        let running = l.step(2000);
        assert!(!running, "alpha {}", l.alpha());
        for i in 0..50 {
            for j in i + 1..50 {
                assert!(dist(&l, i, j) > 20.0);
            }
        }
        assert!(l.positions().iter().all(|v| v.is_finite()));
    }

    #[test]
    fn barnes_hut_matches_brute_force_direction() {
        // Compare the tree against a brute-force charge on a random cloud.
        let n = 400;
        let mut l = ForceLayout::new(n, &[], ForceParams::default());
        for i in 0..n {
            let a = i as f32 * 2.399;
            l.pos[i * 2] = a.cos() * (i as f32).sqrt() * 40.0;
            l.pos[i * 2 + 1] = a.sin() * (i as f32).sqrt() * 40.0;
        }
        let pos = l.pos.clone();
        l.vel.iter_mut().for_each(|v| *v = 0.0);
        l.apply_charge(1.0);
        let mut worst = 0f32;
        for i in 0..n {
            let (mut fx, mut fy) = (0f32, 0f32);
            for j in 0..n {
                if i == j {
                    continue;
                }
                let dx = pos[j * 2] - pos[i * 2];
                let dy = pos[j * 2 + 1] - pos[i * 2 + 1];
                let mut d = dx * dx + dy * dy;
                if d < DISTANCE_MIN2 {
                    d = (DISTANCE_MIN2 * d).sqrt();
                }
                fx += dx * -1000.0 / d;
                fy += dy * -1000.0 / d;
            }
            let (bx, by) = (l.vel[i * 2], l.vel[i * 2 + 1]);
            let err = ((bx - fx).powi(2) + (by - fy).powi(2)).sqrt()
                / (fx * fx + fy * fy).sqrt().max(1e-3);
            worst = worst.max(err);
        }
        assert!(worst < 0.25, "worst relative error {worst}");
    }

    #[test]
    fn coincident_nodes_do_not_explode() {
        let mut l = ForceLayout::new(100, &[], ForceParams::default());
        l.pos.iter_mut().for_each(|v| *v = 5.0);
        l.step(50);
        assert!(l.positions().iter().all(|v| v.is_finite()));
    }

    #[test]
    fn pinned_node_stays_put() {
        let mut l = ForceLayout::new(3, &[(0, 1), (1, 2)], ForceParams::default());
        l.pin(1, 100.0, -50.0);
        l.step(100);
        assert_eq!(&l.positions()[2..4], &[100.0, -50.0]);
        l.unpin(1);
        l.reheat(0.5);
        l.step(5);
        assert_ne!(&l.positions()[2..4], &[100.0, -50.0]);
    }

    #[test]
    fn warm_restart_keeps_surviving_positions() {
        let ids: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let mut l = ForceLayout::with_ids(ids, &[(0, 1), (1, 2)], ForceParams::default());
        l.step(300);
        let b = (l.positions()[2], l.positions()[3]);
        let new_ids: Vec<String> = ["b", "d", "c"].iter().map(|s| s.to_string()).collect();
        l.set_graph(new_ids, &[(0, 1), (0, 2)]);
        assert_eq!((l.positions()[0], l.positions()[1]), b);
        assert!(l.alpha() >= 0.3);
        // "d" starts near its placed neighbor "b".
        assert!(dist(&l, 0, 1) < 200.0);
        assert_eq!(l.index_of("c"), Some(2));
        l.set_params(ForceParams {
            link_distance: 100.0,
            ..Default::default()
        });
        assert!(l.step(10));
    }
}
