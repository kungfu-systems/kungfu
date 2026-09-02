# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

from kungfu import agent_work_lab as lab
from kungfu import assignment_orchestration as orchestration
from kungfu import project_template
from kungfu import projects as project_registry
from kungfu.workspace import resolve_workspace_target


class _NativeProjectTourOperations:
    def __init__(self, ctx, allow_foreign_binding):
        self.ctx = ctx
        self.allow_foreign_binding = allow_foreign_binding

    @staticmethod
    def _work(project):
        work = project.get("initialWork")
        if not isinstance(work, dict):
            raise ValueError("Project Tour Starter Project has no initial Work")
        return work

    def create_or_resume(self, destination, resume):
        if resume:
            receipt = project_template.resume_project_template(destination)
        else:
            plan = lab.plan_project_template(lab.DEFAULT_TEMPLATE_ID, destination)
            receipt = lab.create_project_template(
                lab.DEFAULT_TEMPLATE_ID,
                destination,
                expected_plan_root=plan["planRoot"],
                actor="project-tour",
            )
        initial = dict(receipt["initialWork"])
        if resume:
            retained = next(
                (
                    row
                    for row in receipt.get("works") or []
                    if row.get("assignmentId") == initial["assignmentId"]
                ),
                None,
            )
            if retained:
                initial = dict(retained)
        else:
            captured = orchestration.load_captured_request(initial["requestPath"])
            definition = captured["request"].get("workDefinition") or {}
            initial.update(
                title=str(definition.get("title") or initial["assignmentId"]),
                objective=str(definition.get("objective") or ""),
                acceptanceChecks=list(definition.get("acceptance_criteria") or []),
            )
        selection = project_registry.select_project(
            destination, config_home=self.ctx.config_home
        )
        return {
            "schema": "kungfu.project-tour.project/v1",
            "status": "resumed" if resume else "created",
            "destination": str(Path(destination).expanduser().resolve()),
            "receipt": receipt,
            "initialWork": initial,
            "selection": selection,
        }

    def start_attempt(self, project, scenario, on_event):
        from kungfu.cli.commands import assignment as work_commands
        from kungfu.cli.commands import run as run_commands

        work = self._work(project)
        profile = run_commands._provider_profile(
            "synthetic",
            config_home=self.ctx.config_home,
            runtime_home=self.ctx.home,
            mock_scenario=scenario,
        )
        plan = work_commands._work_start_plan(
            config_home=self.ctx.config_home,
            runtime_home=self.ctx.home,
            request_file=Path(work["requestPath"]),
            workspace_root=project["destination"],
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            profile_id=profile["id"],
            actor="local-user",
            allow_foreign_binding=self.allow_foreign_binding,
        )
        if plan.get("executable") is not True:
            raise ValueError("Mock Agent start plan is not executable")
        return work_commands.start_work.callback.__wrapped__(
            self.ctx,
            Path(work["requestPath"]),
            project["destination"],
            False,
            work["initiativeId"],
            work["assignmentId"],
            profile["id"],
            "local-user",
            plan["planRoot"],
            True,
            False,
            self.allow_foreign_binding,
            False,
            on_event,
        )

    def review(self, receipt, on_event):
        from kungfu.cli.commands import assignment as work_commands

        report = receipt.get("agentReport") or {}
        report_path = (report.get("episode") or {}).get("reportPath")
        workspace = (receipt.get("workspace") or {}).get("workspace_root")
        work = receipt.get("work") or {}
        if not report_path or not workspace or not work:
            raise ValueError("Project Tour Agent receipt is not reviewable")
        reviewer = "kungfu.mock-agent.review-fit"
        plan = work_commands._work_review_plan(
            config_home=self.ctx.config_home,
            runtime_home=self.ctx.home,
            agent_report_file=Path(report_path),
            workspace_root=workspace,
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            reviewer_profile_id=reviewer,
            allow_foreign_binding=self.allow_foreign_binding,
        )
        if plan.get("executable") is not True:
            raise ValueError("Mock Reviewer plan is not executable")
        return work_commands.review_agent_run.callback.__wrapped__(
            self.ctx,
            Path(report_path),
            workspace,
            False,
            work["initiativeId"],
            work["assignmentId"],
            reviewer,
            plan["planRoot"],
            True,
            False,
            self.allow_foreign_binding,
            False,
            on_event,
        )

    def close(self, project):
        from kungfu.cli.commands import assignment as work_commands

        work = self._work(project)
        services = work_commands._close_services()
        plan = work_commands.assignment_close.build_plan(
            workspace_root=project["destination"],
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            services=services,
        )
        if plan.get("executable") is not True:
            raise ValueError("Project Tour native settlement plan is not executable")
        request = work_commands.assignment_close.CloseRequest(
            workspace_root=project["destination"],
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            actor="local-user",
            expected_plan_root=plan["planRoot"],
            execute=True,
        )
        return work_commands.assignment_close.execute(request, services)

    def capture_followup(self, destination):
        assignment_id = "assignment-prepare-launch-handoff-project-tour"
        request = {
            "schema": "kungfu.assignment-request/v1",
            "source": {
                "kind": "kungfu-product",
                "surface": "project-tour-next-work",
            },
            "retention": {
                "policy": "explicit-expiry-retain-bytes-v1",
                "expiresAt": None,
            },
            "workDefinition": {
                "assignment_id": assignment_id,
                "initiative_id": "project-work-tour-next",
                "title": "Prepare the launch handoff for the next operator",
                "objective": "Prepare the launch handoff for the next operator",
                "acceptance_criteria": [
                    "A new business outcome remains visible beside the settled launch-brief Work",
                    "Validation evidence and unresolved risks are reported",
                ],
            },
        }
        target = resolve_workspace_target("capture-only", destination, cwd=destination)
        return orchestration.capture_assignment_request(request, target)

    def inventory(self, destination):
        return project_registry.work_inventory(destination)
