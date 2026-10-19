"""Retrieval quality gate: the test set in evals/ must not regress.

Indexes evals/corpus with the configured embedding and reranking models and checks
per-group metrics against floors set a little below the measured baseline, so a
change that makes search worse fails here instead of in front of users.
Run the full report with `make eval`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ragdag.evals import format_report, run

ROOT = Path(__file__).resolve().parents[2] / "evals"

# group -> (min hit@3, min hit@k); offtopic -> min share refused
FLOORS = {
    "en": (0.95, 1.0),
    "ar->ar": (1.0, 1.0),
    "ar->en": (1.0, 1.0),
    "en->ar": (0.66, 1.0),
}
OFFTOPIC_REFUSED = 1.0


@pytest.mark.eval
def test_retrieval_quality_does_not_regress():
    report = run(ROOT / "corpus", ROOT / "retrieval_cases.json", rerank=True)
    print("\n" + format_report(report))
    failures = []
    for group, (min_hit3, min_hitk) in FLOORS.items():
        g = report.group(group)
        if g.hit_at_3 < min_hit3 or g.hit_at_k < min_hitk:
            failures.append(
                f"{group}: hit@3 {g.hit_at_3:.0%} (min {min_hit3:.0%}), "
                f"hit@k {g.hit_at_k:.0%} (min {min_hitk:.0%})"
            )
        if g.gate_pass < 1.0:
            failures.append(f"{group}: {1 - g.gate_pass:.0%} of answerable questions refused")
    off = report.group("offtopic")
    if off.gate_pass < OFFTOPIC_REFUSED:
        failures.append(f"offtopic: only {off.gate_pass:.0%} refused (min {OFFTOPIC_REFUSED:.0%})")
    assert not failures, "\n".join(failures)
