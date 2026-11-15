"use strict";

(function attachApprovalExplanation(root) {
  function displayApprovalExplanation(explanation, tr) {
    if (!explanation || typeof explanation !== "object") return null;
    if (!explanation.riskCode && explanation.reason === "命令串联了多个步骤，部分行为无法静态确认") {
      explanation = { ...explanation, riskCode: "composite_unanalyzed" };
    }
    const operations = new Set(["delete", "copy", "move", "write_file", "append_file", "package_install", "package_remove", "git_push",
      "git_force_push", "git_reset", "git_reset_hard", "git_commit", "service_start", "service_stop", "service_restart"]);
    if (!operations.has(explanation.operation) && !explanation.riskCode) {
      return /^包含\s*\d+\s*步操作(?:，.*)?$/.test(String(explanation.summary || "").trim())
        ? { ...explanation, summary: "" } : explanation;
    }
    const targets = operations.has(explanation.operation) && Array.isArray(explanation.targets) ? explanation.targets.filter(v => typeof v === "string" && v.trim()) : [];
    const target = ["copy", "move"].includes(explanation.operation) && targets.length >= 2
      ? `${targets.slice(0, -1).join(", ")} → ${targets.at(-1)}` : targets.join(", ");
    const action = tr(`decisionSheet.operation.${operations.has(explanation.operation) ? explanation.operation : "run"}`);
    const summary = (explanation.conditional ? tr("decisionSheet.operation.may", { action }) : action) + (target ? `: ${target}` : "");
    let riskKey = "";
    if (explanation.riskCode === "composite_unanalyzed") riskKey = "partial";
    else if (explanation.riskCode === "delete_filesystem_root") riskKey = "root";
    else if (explanation.riskCode === "delete_system_path") riskKey = "system_delete";
    else if (explanation.riskCode === "delete_git_metadata") riskKey = "git_metadata";
    else if (explanation.riskCode === "delete_project_root") riskKey = "project_root";
    else if (explanation.riskCode === "delete_home_root") riskKey = "home_root";
    else if (["force_push", "script_interpreter_force_push"].includes(explanation.riskCode)) riskKey = "force_push";
    else if (explanation.riskCode === "delete_glob_pattern") riskKey = "glob";
    else if (["delete_variable_target", "delete_unresolvable", "delete_no_target"].includes(explanation.riskCode)) riskKey = "unknown_target";
    else if (["privilege_escalation", "sudo_script_interpreter", "sudo_system_admin", "sudo_service_control", "declared_privileged_op", "install_sudo", "script_interpreter_sudo"].includes(explanation.riskCode)) riskKey = "privilege";
    else if (["download_and_execute", "script_interpreter_download_exec"].includes(explanation.riskCode)) riskKey = "download";
    else if (["sensitive_system_read", "protected_control_read"].includes(explanation.riskCode)) riskKey = "sensitive";
    else if (["file_edit_system_path", "system_path_write", "shell_control_system_path", "protected_control_path", "script_interpreter_system_path"].includes(explanation.riskCode)) riskKey = "system";
    else if (["network_egress", "git_remote_operation"].includes(explanation.riskCode)) riskKey = "network";
    else if (explanation.riskCode === "git_clean_force") riskKey = "git_clean";
    else if (["destructive_erase", "shell_control_destructive", "interpreter_destructive_keyword", "script_interpreter_destructive", "script_interpreter_delete", "find_exec_destructive", "xargs_destructive"].includes(explanation.riskCode)) riskKey = "delete";
    else if (String(explanation.riskCode || "").startsWith("delete_")) riskKey = "delete";
    else if (String(explanation.riskCode || "").startsWith("script_interpreter_")) riskKey = "script";
    else if (explanation.riskCode && !["ordinary_command", "no_command"].includes(explanation.riskCode)) riskKey = "unknown";
    let reason = riskKey ? tr(`decisionSheet.operationRisk.${riskKey}`) : (explanation.riskCode ? "" : explanation.reason);
    if (explanation.operation === "delete" && riskKey !== "root" && !String(explanation.riskCode || "").startsWith("delete_")) reason = [tr("decisionSheet.operationRisk.delete"), reason].filter(Boolean).join(" ");
    if (explanation.elevated && riskKey !== "privilege") reason = [reason, tr("decisionSheet.operationRisk.privilege")].filter(Boolean).join(" ");
    if (explanation.partial && riskKey !== "partial") reason = [reason, tr("decisionSheet.operationRisk.partial")].filter(Boolean).join(" ");
    if (["write_file", "copy", "move"].includes(explanation.operation)) reason = [reason, tr("decisionSheet.operationRisk.overwrite")].filter(Boolean).join(" ");
    if (explanation.operation === "git_reset_hard") reason = [reason, tr("decisionSheet.operationRisk.git_reset_hard")].filter(Boolean).join(" ");
    if (explanation.providerConflict) reason = [reason, tr("decisionSheet.operationRisk.provider_conflict")].filter(Boolean).join(" ");
    let saferKey = "";
    if (["force_push", "script_interpreter_force_push"].includes(explanation.riskCode)) saferKey = "force_push";
    else if (["delete_glob_pattern", "delete_find_batch", "find_exec_destructive", "xargs_destructive"].includes(explanation.riskCode)) saferKey = "preview";
    else if (["delete_variable_target", "delete_unresolvable", "delete_no_target"].includes(explanation.riskCode)) saferKey = "target";
    else if (["delete_filesystem_root", "delete_home_root", "delete_project_root", "delete_git_metadata"].includes(explanation.riskCode)) saferKey = "backup";
    else if (["download_and_execute", "script_interpreter_download_exec"].includes(explanation.riskCode)) saferKey = "download";
    return { ...explanation, operation: operations.has(explanation.operation) ? explanation.operation : undefined,
      summary, reason, saferAlternative: saferKey ? tr(`decisionSheet.operationSafer.${saferKey}`) : (explanation.riskCode ? "" : explanation.saferAlternative) };
  }

  root.ragentApprovalExplanation = displayApprovalExplanation;
})(window);
