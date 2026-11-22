import { withDatabase } from './collaboration-store.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { enqueueResponsibilityNotification } from './responsibility-notifications.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS responsibilities (id TEXT PRIMARY KEY, owner_principal_id TEXT NOT NULL, project_id TEXT NOT NULL, organization_id TEXT NOT NULL, objective TEXT NOT NULL, success_criteria_json TEXT NOT NULL, lifecycle TEXT NOT NULL, revision INTEGER NOT NULL, row_version INTEGER NOT NULL, policy_revision INTEGER NOT NULL, next_check_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS responsibility_scope ON responsibilities(organization_id,project_id,id);
CREATE TABLE IF NOT EXISTS responsibility_policy_revisions (responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), revision INTEGER NOT NULL, policy_json TEXT NOT NULL, policy_digest TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, PRIMARY KEY(responsibility_id,revision));
CREATE TRIGGER IF NOT EXISTS responsibility_policy_no_update BEFORE UPDATE ON responsibility_policy_revisions BEGIN SELECT RAISE(ABORT,'immutable policy'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_policy_no_delete BEFORE DELETE ON responsibility_policy_revisions BEGIN SELECT RAISE(ABORT,'immutable policy'); END;
CREATE TABLE IF NOT EXISTS responsibility_receipts (actor_id TEXT NOT NULL, operation TEXT NOT NULL, target_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id,operation,target_id,idempotency_key));
CREATE TABLE IF NOT EXISTS responsibility_activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), type TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_activity_dedup (responsibility_id TEXT NOT NULL, event_key TEXT NOT NULL, PRIMARY KEY(responsibility_id,event_key));
CREATE TABLE IF NOT EXISTS responsibility_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, resource TEXT NOT NULL, event_id TEXT NOT NULL, occurred_at TEXT, received_at TEXT NOT NULL, payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL, verification TEXT NOT NULL, UNIQUE(source,account,resource,event_id));
CREATE TABLE IF NOT EXISTS responsibility_subscriptions (id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), source TEXT NOT NULL, interval_ms INTEGER NOT NULL, next_due_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(responsibility_id,source));
CREATE TABLE IF NOT EXISTS responsibility_trigger_bindings (id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL UNIQUE,responsibility_id TEXT NOT NULL REFERENCES responsibilities(id),owner_id TEXT NOT NULL,organization_id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,config_json TEXT NOT NULL,config_digest TEXT NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_trigger_bridge_state (binding_id TEXT PRIMARY KEY REFERENCES responsibility_trigger_bindings(id),state TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at TEXT,last_error TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_trigger_schedule (binding_id TEXT PRIMARY KEY REFERENCES responsibility_trigger_bindings(id),occurrence INTEGER NOT NULL,scheduled_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_trigger_event_sources (binding_id TEXT PRIMARY KEY REFERENCES responsibility_trigger_bindings(id),starts_at TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'ready',last_error TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_trigger_event_queue (binding_id TEXT NOT NULL REFERENCES responsibility_trigger_bindings(id),occurrence_key TEXT NOT NULL,run_id TEXT NOT NULL,finalized_at TEXT NOT NULL,payload_digest TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,lease_token TEXT,lease_generation INTEGER NOT NULL DEFAULT 0,lease_until TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(binding_id,occurrence_key));
CREATE TABLE IF NOT EXISTS responsibility_trigger_receipts (binding_id TEXT NOT NULL REFERENCES responsibility_trigger_bindings(id),occurrence_key TEXT NOT NULL,payload_digest TEXT NOT NULL,wake_id TEXT NOT NULL REFERENCES responsibility_wakes(id),created_at TEXT NOT NULL,PRIMARY KEY(binding_id,occurrence_key));
CREATE TRIGGER IF NOT EXISTS responsibility_trigger_identity_no_update BEFORE UPDATE ON responsibility_trigger_bindings WHEN NEW.id<>OLD.id OR NEW.trigger_id<>OLD.trigger_id OR NEW.responsibility_id<>OLD.responsibility_id OR NEW.owner_id<>OLD.owner_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.session_id<>OLD.session_id OR NEW.config_json<>OLD.config_json OR NEW.config_digest<>OLD.config_digest OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'immutable trigger binding identity'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_trigger_binding_no_delete BEFORE DELETE ON responsibility_trigger_bindings BEGIN SELECT RAISE(ABORT,'immutable trigger binding'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_trigger_receipt_no_update BEFORE UPDATE ON responsibility_trigger_receipts BEGIN SELECT RAISE(ABORT,'immutable trigger receipt'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_trigger_receipt_no_delete BEFORE DELETE ON responsibility_trigger_receipts BEGIN SELECT RAISE(ABORT,'immutable trigger receipt'); END;
CREATE TABLE IF NOT EXISTS responsibility_repository_facts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, root_path TEXT NOT NULL, git_root TEXT NOT NULL, repository TEXT NOT NULL, remote_url TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_project_facts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, root_session_id TEXT NOT NULL, root_real_path TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_code_baselines (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, project_fact_id TEXT NOT NULL, repository_fact_id TEXT NOT NULL, head_sha TEXT NOT NULL, branch TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS responsibility_code_baseline_no_update BEFORE UPDATE ON responsibility_code_baselines BEGIN SELECT RAISE(ABORT,'immutable code baseline'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_code_baseline_no_delete BEFORE DELETE ON responsibility_code_baselines BEGIN SELECT RAISE(ABORT,'immutable code baseline'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_project_fact_no_update BEFORE UPDATE ON responsibility_project_facts BEGIN SELECT RAISE(ABORT,'immutable project fact'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_project_fact_no_delete BEFORE DELETE ON responsibility_project_facts BEGIN SELECT RAISE(ABORT,'immutable project fact'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_repository_no_update BEFORE UPDATE ON responsibility_repository_facts BEGIN SELECT RAISE(ABORT,'immutable repository fact'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_repository_no_delete BEFORE DELETE ON responsibility_repository_facts BEGIN SELECT RAISE(ABORT,'immutable repository fact'); END;
CREATE TABLE IF NOT EXISTS responsibility_wakes (id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), responsibility_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, due_at TEXT NOT NULL, state TEXT NOT NULL, lease_generation INTEGER NOT NULL DEFAULT 0, decision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_wake_leases (wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id), owner_token TEXT NOT NULL, generation INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_wake_retry (wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id), last_reason TEXT NOT NULL, next_retry_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_subscription_coalescing (subscription_id TEXT PRIMARY KEY REFERENCES responsibility_subscriptions(id), count INTEGER NOT NULL, first_due_at TEXT NOT NULL, last_due_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_session_contexts (session_id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, responsibility_version INTEGER NOT NULL, policy_revision INTEGER NOT NULL, intent TEXT NOT NULL, activity_cursor INTEGER NOT NULL, row_version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_memory_previews (digest TEXT PRIMARY KEY, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_wake_events (wake_id TEXT NOT NULL REFERENCES responsibility_wakes(id), event_id TEXT NOT NULL REFERENCES responsibility_events(id), PRIMARY KEY(wake_id,event_id));
CREATE TABLE IF NOT EXISTS responsibility_observations (wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_git_observations (wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id),responsibility_id TEXT NOT NULL REFERENCES responsibilities(id),responsibility_revision INTEGER NOT NULL,policy_revision INTEGER NOT NULL,decision_id TEXT NOT NULL,project_fact_id TEXT NOT NULL,observation_json TEXT NOT NULL,observation_digest TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS responsibility_git_observation_no_update BEFORE UPDATE ON responsibility_git_observations BEGIN SELECT RAISE(ABORT,'immutable Git observation'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_git_observation_no_delete BEFORE DELETE ON responsibility_git_observations BEGIN SELECT RAISE(ABORT,'immutable Git observation'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_observation_no_update BEFORE UPDATE ON responsibility_observations BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_observation_no_delete BEFORE DELETE ON responsibility_observations BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
CREATE TABLE IF NOT EXISTS responsibility_decisions (id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), wake_id TEXT NOT NULL REFERENCES responsibility_wakes(id), responsibility_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, state TEXT NOT NULL, input_digest TEXT NOT NULL, proposal_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(wake_id));
CREATE TABLE IF NOT EXISTS responsibility_plans (id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), wake_id TEXT NOT NULL REFERENCES responsibility_wakes(id), responsibility_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, observation_digest TEXT NOT NULL, project_fact_id TEXT NOT NULL, catalog_digest TEXT NOT NULL, proposal_digest TEXT NOT NULL, proposal_json TEXT NOT NULL, packet_id TEXT NOT NULL, packet_digest TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(wake_id));
CREATE TABLE IF NOT EXISTS responsibility_plan_approvals (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES responsibility_plans(id), actor_id TEXT NOT NULL, proposal_digest TEXT NOT NULL, responsibility_row_version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_id,plan_id,idempotency_key));
CREATE TABLE IF NOT EXISTS responsibility_planning_outcomes (wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id), responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), kind TEXT NOT NULL, reason TEXT NOT NULL, next_check_at TEXT, packet_id TEXT NOT NULL, packet_digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_plan_dispatch_retry (plan_id TEXT PRIMARY KEY REFERENCES responsibility_plans(id), reason TEXT NOT NULL, next_retry_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_planning_retry (wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id), reason TEXT NOT NULL, next_retry_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS responsibility_planning_outcome_no_update BEFORE UPDATE ON responsibility_planning_outcomes BEGIN SELECT RAISE(ABORT,'immutable planning outcome'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_planning_outcome_no_delete BEFORE DELETE ON responsibility_planning_outcomes BEGIN SELECT RAISE(ABORT,'immutable planning outcome'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_plan_no_update BEFORE UPDATE ON responsibility_plans BEGIN SELECT RAISE(ABORT,'immutable plan'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_plan_no_delete BEFORE DELETE ON responsibility_plans BEGIN SELECT RAISE(ABORT,'immutable plan'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_plan_approval_no_update BEFORE UPDATE ON responsibility_plan_approvals BEGIN SELECT RAISE(ABORT,'immutable approval'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_plan_approval_no_delete BEFORE DELETE ON responsibility_plan_approvals BEGIN SELECT RAISE(ABORT,'immutable approval'); END;
CREATE TABLE IF NOT EXISTS responsibility_work_links (responsibility_id TEXT NOT NULL REFERENCES responsibilities(id), wake_id TEXT NOT NULL REFERENCES responsibility_wakes(id), decision_id TEXT NOT NULL, goal_id TEXT NOT NULL, workflow_instance_id TEXT NOT NULL, policy_revision INTEGER NOT NULL, responsibility_revision INTEGER NOT NULL, PRIMARY KEY(responsibility_id,wake_id), UNIQUE(workflow_instance_id));
CREATE TRIGGER IF NOT EXISTS responsibility_link_no_update BEFORE UPDATE ON responsibility_work_links BEGIN SELECT RAISE(ABORT,'immutable work link'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_link_no_delete BEFORE DELETE ON responsibility_work_links BEGIN SELECT RAISE(ABORT,'immutable work link'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_decision_no_update BEFORE UPDATE ON responsibility_decisions BEGIN SELECT RAISE(ABORT,'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_decision_no_delete BEFORE DELETE ON responsibility_decisions BEGIN SELECT RAISE(ABORT,'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_wake_identity_no_update BEFORE UPDATE ON responsibility_wakes WHEN NEW.responsibility_id<>OLD.responsibility_id OR NEW.responsibility_revision<>OLD.responsibility_revision OR NEW.policy_revision<>OLD.policy_revision OR NEW.created_at<>OLD.created_at OR (OLD.decision_id IS NOT NULL AND NEW.decision_id IS NOT OLD.decision_id) BEGIN SELECT RAISE(ABORT,'immutable wake identity'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_wake_no_delete BEFORE DELETE ON responsibility_wakes BEGIN SELECT RAISE(ABORT,'immutable wake'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_event_no_update BEFORE UPDATE ON responsibility_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_event_no_delete BEFORE DELETE ON responsibility_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TABLE IF NOT EXISTS responsibility_producer_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  organization_id TEXT,
  project_id TEXT,
  session_id TEXT,
  run_id TEXT,
  event_id TEXT,
  state TEXT,
  occurred_at TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS responsibility_producer_events_session_seq ON responsibility_producer_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS responsibility_producer_events_org_seq ON responsibility_producer_events(organization_id, sequence);
CREATE INDEX IF NOT EXISTS responsibility_producer_events_type_seq ON responsibility_producer_events(event_type, occurred_at, sequence);
CREATE TRIGGER IF NOT EXISTS responsibility_producer_event_no_update BEFORE UPDATE ON responsibility_producer_events BEGIN SELECT RAISE(ABORT,'immutable producer event'); END;
CREATE TABLE IF NOT EXISTS responsibility_producer_event_retention (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  min_available_sequence INTEGER NOT NULL DEFAULT 0,
  max_pruned_occurred_at TEXT,
  pruned_count INTEGER NOT NULL DEFAULT 0,
  last_pruned_at TEXT
);
CREATE TABLE IF NOT EXISTS responsibility_trigger_producer_cursors (
  binding_id TEXT PRIMARY KEY REFERENCES responsibility_trigger_bindings(id),
  last_sequence INTEGER NOT NULL DEFAULT 0,
  retained_floor_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS responsibility_external_watermarks (
  responsibility_id TEXT NOT NULL REFERENCES responsibilities(id),
  source TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  watermark_value TEXT NOT NULL,
  watermark_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(responsibility_id, source, resource_key)
);
CREATE TABLE IF NOT EXISTS responsibility_change_observations (
  wake_id TEXT PRIMARY KEY REFERENCES responsibility_wakes(id),
  responsibility_id TEXT NOT NULL REFERENCES responsibilities(id),
  responsibility_revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  catalog_digest TEXT NOT NULL,
  decision_id TEXT,
  project_fact_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  baseline_wake_id TEXT,
  fingerprint_digest TEXT NOT NULL,
  git_digest TEXT,
  workspace_digest TEXT,
  external_digest TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS responsibility_change_obs_lookup ON responsibility_change_observations(responsibility_id, responsibility_revision, policy_revision, catalog_digest, created_at);
CREATE TRIGGER IF NOT EXISTS responsibility_change_observation_no_update BEFORE UPDATE ON responsibility_change_observations BEGIN SELECT RAISE(ABORT,'immutable change observation'); END;
CREATE TRIGGER IF NOT EXISTS responsibility_change_observation_no_delete BEFORE DELETE ON responsibility_change_observations BEGIN SELECT RAISE(ABORT,'immutable change observation'); END;
`;
export const now = () => new Date().toISOString();
export const newId = prefix => `${prefix}_${randomUUID()}`;
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; return JSON.stringify(value); }
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const error = (message, statusCode = 400, code = 'RESPONSIBILITY_INVALID') => Object.assign(new Error(message), {statusCode,code});
export async function read(fn) { return withDatabase(db => { db.exec(schema); return fn(db); }); }
export async function transaction(fn) { return withDatabase(db => { db.exec(schema); db.exec('BEGIN IMMEDIATE'); try { const result=fn(db); if (result && typeof result.then === 'function') throw error('Async work is forbidden in a transaction',500); db.exec('COMMIT'); return result; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } }, {mutate:true}); }
export function row(r) { return r && {id:r.id,ownerPrincipalId:r.owner_principal_id,projectId:r.project_id,organizationId:r.organization_id,objective:r.objective,successCriteria:JSON.parse(r.success_criteria_json),lifecycle:r.lifecycle,revision:r.revision,rowVersion:r.row_version,policyRevision:r.policy_revision,nextCheckAt:r.next_check_at,createdAt:r.created_at,updatedAt:r.updated_at}; }
export function activity(db,id,type,details={}) { const result=db.prepare('INSERT INTO responsibility_activity(responsibility_id,type,details_json,created_at) VALUES(?,?,?,?)').run(id,type,JSON.stringify(details),now()); enqueueResponsibilityNotification(db,{responsibilityId:id,sequence:result.lastInsertRowid,type}); }
export function activityOnce(db,id,eventKey,type,details={}) { db.exec('CREATE TABLE IF NOT EXISTS responsibility_activity_dedup (responsibility_id TEXT NOT NULL, event_key TEXT NOT NULL, PRIMARY KEY(responsibility_id,event_key))'); const inserted=db.prepare('INSERT OR IGNORE INTO responsibility_activity_dedup VALUES(?,?)').run(id,eventKey);if(!inserted.changes)return false;activity(db,id,type,details);return true; }
export function recordObservation(db,wakeId,kind,payload) { const facts={schemaVersion:1,kind,...payload}; db.prepare('INSERT INTO responsibility_observations VALUES(?,?,?,?,?)').run(wakeId,kind,JSON.stringify(facts),digest(facts),now()); return facts; }
export function receipt(db,actor,operation,target,key,input,fn) { const hash=digest(input); const old=db.prepare('SELECT * FROM responsibility_receipts WHERE actor_id=? AND operation=? AND target_id=? AND idempotency_key=?').get(actor,operation,target,key); if(old) { if(old.payload_digest!==hash) throw error('Idempotency key reused with different input',409,'RESPONSIBILITY_CONFLICT'); return {...JSON.parse(old.result_json),replayed:true}; } const result=fn(); db.prepare('INSERT INTO responsibility_receipts VALUES(?,?,?,?,?,?,?)').run(actor,operation,target,key,hash,JSON.stringify(result),now()); return result; }
