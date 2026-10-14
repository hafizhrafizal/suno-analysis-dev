use rayon::prelude::*;

/// HDBSCAN clustering with cosine distance.
/// Returns cluster labels (0-based integers) or -1 for noise.
///
/// Algorithm:
///   1. Pairwise cosine distances
///   2. Core distances (k-NN where k = min_cluster_size)
///   3. Prim's MST on mutual reachability distance
///   4. Single-linkage dendrogram from MST
///   5. Condensed tree (collapse tiny components → noise)
///   6. Excess-of-mass cluster extraction
///
/// Steps 1 and 2 are the O(n²) bottleneck (each of the n(n-1)/2 pairs does a
/// 1536-dim dot product) — they're embarrassingly parallel across rows/points,
/// so they run on rayon's thread pool. This changes wall-clock time only; the
/// result is bit-identical to the serial version, so clustering stays exact
/// (no sampling/capping of the input).

pub fn cosine_dist(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na < 1e-12 || nb < 1e-12 {
        return 1.0;
    }
    (1.0 - dot / (na.sqrt() * nb.sqrt())).clamp(0.0, 1.0)
}

fn find_root(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]]; // path halving
        x = parent[x];
    }
    x
}

/// Collect all leaf-point indices in the subtree rooted at `node`.
fn collect_leaves(node: usize, n: usize, children_l: &[usize], children_r: &[usize]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut stack = vec![node];
    while let Some(nd) = stack.pop() {
        if nd < n {
            out.push(nd);
        } else {
            let i = nd - n;
            stack.push(children_l[i]);
            stack.push(children_r[i]);
        }
    }
    out
}

pub fn hdbscan(data: &[Vec<f32>], min_cluster_size: usize) -> Vec<i32> {
    let n = data.len();
    if n == 0 {
        return vec![];
    }
    if n < min_cluster_size {
        return vec![0; n];
    }

    let k = min_cluster_size.min(n - 1).max(1);

    // ── 1. Pairwise cosine distance matrix ────────────────────────────────────
    // Each row i only computes j > i (upper triangle), same total work as the
    // serial version — just spread across threads. Mirrored into `dm` after.
    let mut dm = vec![0.0f32; n * n];
    let rows: Vec<Vec<(usize, f32)>> = (0..n)
        .into_par_iter()
        .map(|i| ((i + 1)..n).map(|j| (j, cosine_dist(&data[i], &data[j]))).collect())
        .collect();
    for (i, row) in rows.into_iter().enumerate() {
        for (j, d) in row {
            dm[i * n + j] = d;
            dm[j * n + i] = d;
        }
    }

    // ── 2. Core distances (k-th nearest neighbour) ────────────────────────────
    let core: Vec<f32> = (0..n)
        .into_par_iter()
        .map(|i| {
            let mut row: Vec<f32> = (0..n)
                .filter(|&j| j != i)
                .map(|j| dm[i * n + j])
                .collect();
            row.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            row[k - 1]
        })
        .collect();

    // ── 3. Prim's MST on mutual reachability distance ─────────────────────────
    let mut in_mst = vec![false; n];
    let mut best = vec![f32::MAX; n];
    let mut best_src = vec![0usize; n];
    let mut mst: Vec<(usize, usize, f32)> = Vec::with_capacity(n - 1);
    best[0] = 0.0;

    for step in 0..n {
        let u = (0..n)
            .filter(|&i| !in_mst[i])
            .min_by(|&a, &b| best[a].partial_cmp(&best[b]).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap();
        in_mst[u] = true;
        if step > 0 {
            mst.push((best_src[u], u, best[u]));
        }
        for v in 0..n {
            if in_mst[v] {
                continue;
            }
            let w = core[u].max(core[v]).max(dm[u * n + v]);
            if w < best[v] {
                best[v] = w;
                best_src[v] = u;
            }
        }
    }
    mst.sort_unstable_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

    // ── 4. Single-linkage dendrogram from MST ────────────────────────────────
    // Internal nodes are indexed n .. 2n-2 (one per merge).
    // We store the two children and the merge lambda for each internal node.
    let max_internal = n - 1;
    let mut dend_left = vec![0usize; max_internal];
    let mut dend_right = vec![0usize; max_internal];
    let mut dend_lambda = vec![0.0f32; max_internal];
    let mut dend_size = vec![0usize; max_internal];

    // Union-Find for building the dendrogram
    let total_nodes = 2 * n;
    let mut uf: Vec<usize> = (0..total_nodes).collect();
    let mut uf_size: Vec<usize> = (0..total_nodes)
        .map(|i| if i < n { 1 } else { 0 })
        .collect();
    // Map from UF root → current dendrogram node representing that component
    let mut comp_dend_node: Vec<usize> = (0..n).collect(); // starts as leaf nodes

    let mut next_internal = 0usize; // index into dend_* arrays; actual node ID = n + next_internal

    for &(u, v, w) in &mst {
        let lambda = if w > 1e-10 { 1.0 / w } else { 1e10 };
        let ru = find_root(&mut uf, u);
        let rv = find_root(&mut uf, v);
        if ru == rv {
            continue;
        }

        let node_u = comp_dend_node[ru];
        let node_v = comp_dend_node[rv];
        let sz_u = uf_size[ru];
        let sz_v = uf_size[rv];

        let ii = next_internal;
        next_internal += 1;
        dend_left[ii] = node_u;
        dend_right[ii] = node_v;
        dend_lambda[ii] = lambda;
        dend_size[ii] = sz_u + sz_v;

        // Merge in UF (larger absorbs smaller to keep balance)
        let (big, small) = if sz_u >= sz_v { (ru, rv) } else { (rv, ru) };
        uf[small] = big;
        uf_size[big] = sz_u + sz_v;
        comp_dend_node[big] = n + ii;
    }

    let num_merges = next_internal;
    if num_merges == 0 {
        return vec![0; n];
    }
    let root_node = n + num_merges - 1; // the last created internal node is the tree root

    // ── 5. Build condensed tree ───────────────────────────────────────────────
    // Condensed cluster nodes: we assign integer IDs 0, 1, 2, ...
    // For each condensed cluster we track:
    //   birth_lambda, stability, parent_cid, children_cids
    //
    // We traverse the single-linkage tree top-down (DFS).
    // Stack entry: (dendrogram_node, condensed_cluster_id_of_parent, lambda_when_entered)
    //
    // Rules:
    //   • If both sub-trees of a split have size >= min_cluster_size:
    //       → real split: create two new condensed cluster children
    //   • Otherwise the "too small" sub-tree's points fall out at this lambda
    //       → contribute stability to the current condensed cluster
    //       → those points are marked noise (unless later absorbed)

    let mut cond_birth: Vec<f32> = vec![0.0];      // cluster 0 = root
    let mut cond_stability: Vec<f32> = vec![0.0];
    let mut cond_parent: Vec<i64> = vec![-1];
    let mut cond_children: Vec<Vec<usize>> = vec![vec![]];
    let mut next_cid = 1usize;

    // For each point: which condensed cluster it belongs to and its fall-out lambda
    let mut point_cid: Vec<usize> = vec![0; n];
    let mut point_fall_lambda: Vec<f32> = vec![0.0; n];

    // DFS: (dendrogram_node, current_condensed_cluster, lambda_of_edge_into_this_node)
    let mut stack: Vec<(usize, usize, f32)> = vec![(root_node, 0, 0.0)];

    while let Some((node, cur_cid, entry_lambda)) = stack.pop() {
        if node < n {
            // Leaf point – it "falls out" of cur_cid at entry_lambda
            point_cid[node] = cur_cid;
            point_fall_lambda[node] = entry_lambda;
            cond_stability[cur_cid] += (entry_lambda - cond_birth[cur_cid]).max(0.0);
            continue;
        }

        let ii = node - n;
        let left = dend_left[ii];
        let right = dend_right[ii];
        let split_lambda = dend_lambda[ii];
        let left_sz = if left < n { 1 } else { dend_size[left - n] };
        let right_sz = if right < n { 1 } else { dend_size[right - n] };

        let left_ok = left_sz >= min_cluster_size;
        let right_ok = right_sz >= min_cluster_size;

        match (left_ok, right_ok) {
            (true, true) => {
                // Both sides big enough → real split → create two child clusters
                let cid_l = next_cid;
                next_cid += 1;
                let cid_r = next_cid;
                next_cid += 1;

                cond_birth.push(split_lambda);
                cond_stability.push(0.0);
                cond_parent.push(cur_cid as i64);
                cond_children.push(vec![]);

                cond_birth.push(split_lambda);
                cond_stability.push(0.0);
                cond_parent.push(cur_cid as i64);
                cond_children.push(vec![]);

                cond_children[cur_cid].push(cid_l);
                cond_children[cur_cid].push(cid_r);

                stack.push((left, cid_l, split_lambda));
                stack.push((right, cid_r, split_lambda));
            }
            (true, false) => {
                // Right side too small → those points fall out as noise contributions
                let noise_pts = collect_leaves(right, n, &dend_left, &dend_right);
                for p in noise_pts {
                    point_cid[p] = cur_cid;
                    point_fall_lambda[p] = split_lambda;
                    cond_stability[cur_cid] += (split_lambda - cond_birth[cur_cid]).max(0.0);
                }
                // Continue traversing left side as the same cluster
                stack.push((left, cur_cid, split_lambda));
            }
            (false, true) => {
                let noise_pts = collect_leaves(left, n, &dend_left, &dend_right);
                for p in noise_pts {
                    point_cid[p] = cur_cid;
                    point_fall_lambda[p] = split_lambda;
                    cond_stability[cur_cid] += (split_lambda - cond_birth[cur_cid]).max(0.0);
                }
                stack.push((right, cur_cid, split_lambda));
            }
            (false, false) => {
                // Both sides too small → all fall out, cluster ends here
                for sub in [left, right] {
                    let pts = collect_leaves(sub, n, &dend_left, &dend_right);
                    for p in pts {
                        point_cid[p] = cur_cid;
                        point_fall_lambda[p] = split_lambda;
                        cond_stability[cur_cid] += (split_lambda - cond_birth[cur_cid]).max(0.0);
                    }
                }
            }
        }
    }

    // ── 6. Excess-of-mass cluster selection ──────────────────────────────────
    // For each condensed cluster node, decide: keep this cluster as a leaf,
    // or propagate to its children (if sum of children stability > own stability).
    //
    // Process bottom-up (leaves first) using topological order.
    let num_cid = next_cid;
    let mut selected = vec![false; num_cid];
    // For propagation we need topological order (children before parents)
    // Since we created cids in DFS order (parents before children for the condensed tree),
    // we iterate in reverse.
    let mut propagated_stability = cond_stability.clone();

    for cid in (0..num_cid).rev() {
        let children = &cond_children[cid];
        if children.is_empty() {
            // Leaf cluster node → always select it
            selected[cid] = true;
        } else {
            let children_sum: f32 = children.iter().map(|&c| propagated_stability[c]).sum();
            if propagated_stability[cid] >= children_sum {
                // Keep this cluster, deselect all descendants
                selected[cid] = true;
                // Zero out children so they don't get used
                for &c in children {
                    propagated_stability[c] = 0.0;
                }
            } else {
                // Use children
                selected[cid] = false;
                propagated_stability[cid] = children_sum;
            }
        }
    }

    // ── 7. Assign labels ──────────────────────────────────────────────────────
    // Find selected leaf clusters (selected[cid] = true AND cid is a leaf or wins over children)
    // We need to walk up the condensed tree for each point to find its selected cluster.

    // For each condensed cluster node, find the nearest selected ancestor (or self).
    let mut cid_to_label: Vec<i32> = vec![-1; num_cid];
    let mut label_counter = 0i32;

    // Collect truly selected clusters: selected[cid] = true
    // But we may have selected a non-leaf cid (when it beat its children); its points get that label.
    for cid in 0..num_cid {
        if selected[cid] {
            cid_to_label[cid] = label_counter;
            label_counter += 1;
        }
    }

    // For each point, walk up the condensed tree to find its selected cluster.
    let mut labels = vec![-1i32; n];
    for p in 0..n {
        let mut cur = point_cid[p] as i64;
        while cur >= 0 {
            let c = cur as usize;
            if selected[c] {
                labels[p] = cid_to_label[c];
                break;
            }
            cur = cond_parent[c];
        }
        // If cur < 0 (reached root without finding selected): stays -1 (noise)
    }

    // Edge case: if everything is noise, fall back to single cluster
    if labels.iter().all(|&l| l < 0) {
        return vec![0; n];
    }

    labels
}

/// Compute the centroid (mean) of a set of f32 embeddings.
pub fn centroid(embeddings: &[Vec<f32>]) -> Vec<f32> {
    if embeddings.is_empty() {
        return vec![];
    }
    let dim = embeddings[0].len();
    let mut sum = vec![0.0f32; dim];
    for e in embeddings {
        for (s, v) in sum.iter_mut().zip(e.iter()) {
            *s += v;
        }
    }
    let n = embeddings.len() as f32;
    sum.iter_mut().for_each(|s| *s /= n);
    sum
}

/// Given a set of indices belonging to a cluster and their embeddings,
/// return (closest_idx, furthest_idx) relative to the cluster centroid.
/// Indices are into the original `all_embeddings` slice.
pub fn closest_and_furthest(
    all_embeddings: &[Vec<f32>],
    cluster_indices: &[usize],
) -> Option<(usize, usize)> {
    if cluster_indices.is_empty() {
        return None;
    }
    if cluster_indices.len() == 1 {
        return Some((cluster_indices[0], cluster_indices[0]));
    }

    let cluster_vecs: Vec<&Vec<f32>> = cluster_indices.iter().map(|&i| &all_embeddings[i]).collect();
    let c = centroid(&cluster_vecs.iter().map(|v| (*v).clone()).collect::<Vec<_>>());

    let mut min_dist = f32::MAX;
    let mut max_dist = f32::MIN;
    let mut closest = cluster_indices[0];
    let mut furthest = cluster_indices[0];

    for &idx in cluster_indices {
        let d = cosine_dist(&all_embeddings[idx], &c);
        if d < min_dist {
            min_dist = d;
            closest = idx;
        }
        if d > max_dist {
            max_dist = d;
            furthest = idx;
        }
    }

    Some((closest, furthest))
}
