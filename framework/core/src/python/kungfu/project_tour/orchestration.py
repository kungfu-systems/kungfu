# SPDX-License-Identifier: Apache-2.0

"""Single-process orchestration for one truthful Project Tour episode."""

from __future__ import annotations

from dataclasses import dataclass
import os
import time
from typing import Any, Callable, Protocol

from kungfu.initiative_family.canonical import semantic_root


EVENT_SCHEMA = "kungfu.project-tour.episode-event/v1"
REPORT_SCHEMA = "kungfu.project-tour.episode-report/v1"


class ProjectTourOperations(Protocol):
    def create_or_resume(self, destination: str, resume: bool) -> dict[str, Any]: ...

    def start_attempt(
        self,
        project: dict[str, Any],
        scenario: str,
        on_event: Callable[[dict[str, Any]], None],
    ) -> dict[str, Any]: ...

    def review(
        self,
        receipt: dict[str, Any],
        on_event: Callable[[dict[str, Any]], None],
    ) -> dict[str, Any]: ...

    def close(self, project: dict[str, Any]) -> dict[str, Any]: ...

    def capture_followup(self, destination: str) -> dict[str, Any]: ...

    def inventory(self, destination: str) -> dict[str, Any]: ...


@dataclass(frozen=True)
class ProjectTourEpisodeRequest:
    destination: str
    episode: str
    resume: bool = False
    guide_dwell_ms: int = 8000
    guide_gap_ms: int = 400
    episode_two_guide_dwell_ms: int = 7000
    episode_two_final_guide_dwell_ms: int = 6400

    def validate(self) -> None:
        if self.episode not in {"1", "2"}:
            raise ValueError("Project Tour controller episode must be 1 or 2")
        if not self.destination:
            raise ValueError("Project Tour destination is required")
        for value in (
            self.guide_dwell_ms,
            self.guide_gap_ms,
            self.episode_two_guide_dwell_ms,
            self.episode_two_final_guide_dwell_ms,
        ):
            if value < 0:
                raise ValueError("Project Tour pacing must not be negative")


class ProjectTourEpisodeRunner:
    def __init__(
        self,
        request: ProjectTourEpisodeRequest,
        operations: ProjectTourOperations,
        emit: Callable[[dict[str, Any]], None],
        *,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        request.validate()
        self.request = request
        self.operations = operations
        self.emit_output = emit
        self.sleep = sleep
        self.monotonic = monotonic
        self.started_at = monotonic()
        self.index = 0
        self.timings: list[dict[str, Any]] = []
        self.inventory_query_count = 0

    def event(
        self,
        *,
        kind: str,
        section: str,
        section_tag: str,
        status: str,
        text: str,
        root: str | None = None,
        **extra: Any,
    ) -> None:
        self.index += 1
        payload = {
            "schema": EVENT_SCHEMA,
            "index": self.index,
            "episode": self.request.episode,
            "elapsedMs": round((self.monotonic() - self.started_at) * 1000),
            "kind": kind,
            "section": section,
            "sectionTag": section_tag,
            "status": status,
            "text": text,
            "root": root,
            **extra,
        }
        self.emit_output(payload)

    def guide(self, scene_id: str, dwell_ms: int | None = None) -> None:
        duration = self.request.guide_dwell_ms if dwell_ms is None else dwell_ms
        self.event(
            kind="guide",
            section="PROJECT TOUR GUIDE",
            section_tag="GUIDE",
            status="visible",
            text=scene_id,
            sceneId=scene_id,
        )
        self.sleep(duration / 1000)
        self.event(
            kind="guide",
            section="PROJECT TOUR GUIDE",
            section_tag="GUIDE",
            status="dismissed",
            text=scene_id,
            sceneId=scene_id,
        )
        self.sleep(self.request.guide_gap_ms / 1000)

    def operation(
        self,
        section: str,
        section_tag: str,
        text: str,
        action: Callable[[], dict[str, Any]],
        completed_text: str,
    ) -> dict[str, Any]:
        self.event(
            kind="operation",
            section=section,
            section_tag=section_tag,
            status="running",
            text=text,
        )
        started = self.monotonic()
        try:
            result = action()
        except Exception as error:
            elapsed = round((self.monotonic() - started) * 1000)
            self.timings.append(
                {"section": section, "sectionTag": section_tag, "durationMs": elapsed}
            )
            self.event(
                kind="operation",
                section=section,
                section_tag=section_tag,
                status="failed",
                text=str(error),
                durationMs=elapsed,
            )
            raise
        elapsed = round((self.monotonic() - started) * 1000)
        self.timings.append(
            {"section": section, "sectionTag": section_tag, "durationMs": elapsed}
        )
        self.event(
            kind="operation",
            section=section,
            section_tag=section_tag,
            status="completed",
            text=completed_text,
            durationMs=elapsed,
        )
        return result

    def native_event(
        self, section: str, section_tag: str
    ) -> Callable[[dict[str, Any]], None]:
        def emit(value: dict[str, Any]) -> None:
            self.event(
                kind="native",
                section=section,
                section_tag=section_tag,
                status=str(value.get("status") or "running"),
                text=str(value.get("text") or value.get("stage") or "native event"),
                root=value.get("root"),
                nativeEvent=value,
                activity=value.get("activity"),
            )

        return emit

    def start_attempt(
        self,
        project: dict[str, Any],
        *,
        scenario: str,
        expected_status: str,
        section: str,
        section_tag: str,
    ) -> dict[str, Any]:
        receipt = self.operation(
            section,
            section_tag,
            "Qualifying the exact Mock Agent plan and starting its fresh process",
            lambda: self.operations.start_attempt(
                project, scenario, self.native_event(section, section_tag)
            ),
            "Mock Agent process ended; native Attempt evidence retained",
        )
        if receipt.get("status") != expected_status:
            raise RuntimeError(
                "Mock Agent returned "
                f"{receipt.get('status')}; expected {expected_status}"
            )
        self.event(
            kind="receipt",
            section=section,
            section_tag=section_tag,
            status=str(receipt["status"]),
            text="Attempt receipt retained",
            root=(receipt.get("agentReport") or {}).get("reportRoot"),
            receipt=receipt,
        )
        return receipt

    def final_inventory(self) -> dict[str, Any]:
        self.inventory_query_count += 1
        inventory = self.operation(
            "PROJECT WORK · FINAL RECONCILIATION",
            "WORK",
            "Reconciling the final authoritative Work inventory",
            lambda: self.operations.inventory(self.request.destination),
            "Final authoritative Work inventory reconciled",
        )
        self.event(
            kind="inventory",
            section="PROJECT WORK · FINAL RECONCILIATION",
            section_tag="WORK",
            status="completed",
            text=f"{len(inventory.get('works') or [])} retained Work items reconciled",
            root=inventory.get("inventoryRoot"),
            inventory=inventory,
        )
        return inventory

    def run(self) -> dict[str, Any]:
        project = self.operation(
            "STARTER PROJECT · SETUP",
            "SETUP",
            "Creating or resuming the disposable Starter Project",
            lambda: self.operations.create_or_resume(
                self.request.destination, self.request.resume
            ),
            "Starter Project opened with captured Work",
        )
        self.event(
            kind="project",
            section="STARTER PROJECT · SETUP",
            section_tag="SETUP",
            status="resumed" if self.request.resume else "created",
            text="Disposable Starter Project is ready",
            root=(project.get("receipt") or {}).get("receiptRoot"),
            project=project,
        )

        attempts: list[dict[str, Any]] = []
        review = None
        closed = None
        followup = None
        if self.request.episode == "1":
            self.guide("starter-project")
            self.guide("connection-loss")
            attempts.append(
                self.start_attempt(
                    project,
                    scenario="recovery-story",
                    expected_status="agent-failed",
                    section="MOCK AGENT · ATTEMPT 1",
                    section_tag="A1",
                )
            )
            self.guide("connection-retained")
            self.guide("agent-crash")
            attempts.append(
                self.start_attempt(
                    project,
                    scenario="recovery-story",
                    expected_status="agent-failed",
                    section="MOCK AGENT · ATTEMPT 2",
                    section_tag="A2",
                )
            )
            self.guide("same-work")
        else:
            self.guide("recovery" if self.request.resume else "standalone-recovery")
            completed = self.start_attempt(
                project,
                scenario=(
                    "recovery-story" if self.request.resume else "recovery-delivery"
                ),
                expected_status="agent-finished",
                section="MOCK AGENT · RECOVERY ATTEMPT",
                section_tag="REC",
            )
            attempts.append(completed)
            self.event(
                kind="artifact",
                section="MOCK AGENT · RECOVERY ATTEMPT",
                section_tag="REC",
                status="available",
                text="deliverables/launch-brief.md",
                relativePath="deliverables/launch-brief.md",
            )
            self.guide("independent-review", self.request.episode_two_guide_dwell_ms)
            review = self.operation(
                "INDEPENDENT REVIEW",
                "REV",
                "Qualifying and running a fresh read-only Mock Reviewer",
                lambda: self.operations.review(
                    completed, self.native_event("INDEPENDENT REVIEW", "REV")
                ),
                "Independent review process ended; native review evidence retained",
            )
            if review.get("status") != "review-passed":
                raise RuntimeError(
                    f"Mock review returned {review.get('status')}: "
                    f"{review.get('message') or 'no settlement detail'}"
                )
            self.event(
                kind="receipt",
                section="INDEPENDENT REVIEW",
                section_tag="REV",
                status="review-passed",
                text="Review passed; Work is eligible for settlement",
                root=review.get("receiptRoot"),
                receipt=review,
            )
            self.guide("native-settlement", self.request.episode_two_guide_dwell_ms)
            closed = self.operation(
                "NATIVE SETTLEMENT",
                "SET",
                "Binding review evidence and settling the Work",
                lambda: self.operations.close(project),
                "Review evidence bound; native Work settled",
            )
            if closed.get("status") != "completed":
                raise RuntimeError(f"Native Work close returned {closed.get('status')}")
            self.event(
                kind="receipt",
                section="NATIVE SETTLEMENT",
                section_tag="SET",
                status="completed",
                text="Native settlement receipt retained",
                root=closed.get("receiptRoot"),
                receipt=closed,
            )
            self.guide("next-work", self.request.episode_two_final_guide_dwell_ms)
            followup = self.operation(
                "PROJECT WORK · NEXT OUTCOME",
                "NEXT",
                "Capturing the next business outcome beside settled history",
                lambda: self.operations.capture_followup(self.request.destination),
                "Next business outcome captured",
            )

        inventory = self.final_inventory()
        body = {
            "schema": REPORT_SCHEMA,
            "status": "qualified",
            "episode": self.request.episode,
            "projectPath": self.request.destination,
            "controller": {
                "pid": os.getpid(),
                "processCount": 1,
                "inventoryQueryCount": self.inventory_query_count,
            },
            "project": project,
            "attemptReceipts": attempts,
            "reviewReceipt": review,
            "closeReceipt": closed,
            "followupCapture": followup,
            "finalInventory": inventory,
            "stageTimings": self.timings,
            "eventCount": self.index,
            "durationMs": round((self.monotonic() - self.started_at) * 1000),
        }
        return {**body, "reportRoot": semantic_root(body)}


def run_project_tour_episode(
    request: ProjectTourEpisodeRequest,
    operations: ProjectTourOperations,
    emit: Callable[[dict[str, Any]], None],
    *,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    return ProjectTourEpisodeRunner(
        request,
        operations,
        emit,
        sleep=sleep,
        monotonic=monotonic,
    ).run()
