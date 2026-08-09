# SPDX-License-Identifier: Apache-2.0

from kungfu.project_tour.orchestration import (
    ProjectTourEpisodeRequest,
    run_project_tour_episode,
)


class _FakeOperations:
    def __init__(self, statuses):
        self.statuses = iter(statuses)
        self.calls = []
        self.attempt = 0

    def create_or_resume(self, destination, resume):
        self.calls.append(("create_or_resume", destination, resume))
        return {
            "schema": "kungfu.project-tour.project/v1",
            "status": "resumed" if resume else "created",
            "destination": destination,
            "receipt": {"receiptRoot": "sha256:" + "1" * 64},
            "initialWork": {
                "initiativeId": "starter",
                "assignmentId": "launch-brief",
                "requestRoot": "sha256:" + "2" * 64,
            },
            "selection": {},
        }

    def start_attempt(self, project, scenario, on_event):
        self.attempt += 1
        status = next(self.statuses)
        self.calls.append(("start_attempt", scenario))
        on_event(
            {
                "schema": "kungfu.work-start.event/v1",
                "status": "running",
                "text": f"attempt {self.attempt}",
            }
        )
        return {
            "schema": "kungfu.work-start.receipt/v1",
            "status": status,
            "workspace": {"workspace_root": project["destination"]},
            "work": {
                "initiativeId": "starter",
                "assignmentId": "launch-brief",
            },
            "agentReport": {
                "reportRoot": "sha256:" + str(self.attempt) * 64,
                "episode": {"reportPath": f"/tmp/report-{self.attempt}.json"},
            },
        }

    def review(self, receipt, on_event):
        self.calls.append(("review", receipt["status"]))
        on_event(
            {
                "schema": "kungfu.work-review.event/v1",
                "status": "running",
                "text": "reviewing retained evidence",
            }
        )
        return {
            "schema": "kungfu.work-review.receipt/v1",
            "status": "review-passed",
            "receiptRoot": "sha256:" + "3" * 64,
        }

    def close(self, project):
        self.calls.append(("close", project["destination"]))
        return {
            "schema": "kungfu.work-close.receipt/v1",
            "status": "completed",
            "receiptRoot": "sha256:" + "4" * 64,
        }

    def capture_followup(self, destination):
        self.calls.append(("capture_followup", destination))
        return {"receiptRoot": "sha256:" + "5" * 64}

    def inventory(self, destination):
        self.calls.append(("inventory", destination))
        return {
            "schema": "kungfu.project-work.inventory/v1",
            "projectPath": destination,
            "works": [{"assignmentId": "launch-brief"}],
            "activeWork": None,
            "writeOccurred": False,
            "inventoryRoot": "sha256:" + "6" * 64,
        }


def _run(episode, operations, *, resume=False):
    events = []
    report = run_project_tour_episode(
        ProjectTourEpisodeRequest(
            destination="/tmp/project-tour",
            episode=episode,
            resume=resume,
            guide_dwell_ms=0,
            guide_gap_ms=0,
            episode_two_guide_dwell_ms=0,
            episode_two_final_guide_dwell_ms=0,
        ),
        operations,
        events.append,
        sleep=lambda _seconds: None,
    )
    return report, events


def test_episode_one_uses_one_controller_and_one_final_inventory_query():
    operations = _FakeOperations(["agent-failed", "agent-failed"])

    report, events = _run("1", operations)

    assert report["status"] == "qualified"
    assert report["controller"]["processCount"] == 1
    assert report["controller"]["inventoryQueryCount"] == 1
    assert [call[0] for call in operations.calls] == [
        "create_or_resume",
        "start_attempt",
        "start_attempt",
        "inventory",
    ]
    assert len(report["attemptReceipts"]) == 2
    assert report["reviewReceipt"] is None
    assert report["closeReceipt"] is None
    assert sum(event["kind"] == "inventory" for event in events) == 1
    assert all(event["episode"] == "1" for event in events)


def test_episode_two_preserves_review_settlement_and_followup_receipts():
    operations = _FakeOperations(["agent-finished"])

    report, events = _run("2", operations, resume=True)

    assert report["controller"] == {
        "pid": report["controller"]["pid"],
        "processCount": 1,
        "inventoryQueryCount": 1,
    }
    assert [call[0] for call in operations.calls] == [
        "create_or_resume",
        "start_attempt",
        "review",
        "close",
        "capture_followup",
        "inventory",
    ]
    assert operations.calls[0][-1] is True
    assert report["reviewReceipt"]["status"] == "review-passed"
    assert report["closeReceipt"]["status"] == "completed"
    assert report["followupCapture"]["receiptRoot"].startswith("sha256:")
    assert report["reportRoot"].startswith("sha256:")
    assert [event["kind"] for event in events].count("inventory") == 1
