import { digest, factoryError, factoryTransaction, newId, now, encode, itemRow, goalRow, event } from './work-graph-store.mjs';
import { authorize, required } from './work-graph.mjs';

// A formula is data, not code or a source of authority. Callers must submit the
// resulting proposal through the same Factory Control authorization boundary.
const FORMULAS = Object.freeze({
  'ragent-project-report@1': Object.freeze({
    id:'ragent-project-report', version:1,
    source:'docs/ragent-2.0-autonomy/phase-d-context-organization.zh.md',
    roles:['specialist'], capabilities:['read'],
    rules:[{key:'report',kind:'execution',role:'specialist',accessMode:'read',criteria:['report-reviewed']}],
  }),
  'ragent-responsibility-planner@1': Object.freeze({
    id:'ragent-responsibility-planner', version:1,
    source:'docs/ragent-2.0-autonomy/phase-d-context-organization.zh.md',
    roles:['specialist'], capabilities:['read'],
    rules:[{key:'planning',kind:'execution',role:'specialist',accessMode:'read',criteria:['plan-reviewed']}],
  }),
  'ragent-reviewed-change@1': Object.freeze({
    id:'ragent-reviewed-change', version:1,
    source:'docs/factory-runtime/phase-4-delivery.zh.md',
    roles:['writer','reviewer'], capabilities:['read','write','review'],
    rules:[
      {key:'implementation',kind:'execution',role:'writer',criteria:['candidate-frozen']},
      {key:'review',kind:'review',role:'reviewer',criteria:['review-recorded'],dependsOn:{key:'implementation',milestone:'candidate_ready'}},
      {key:'integration',kind:'integration',role:'writer',criteria:['integration-recorded'],dependsOn:{key:'review',milestone:'accepted'}},
    ],
  }),
  'ragent-reviewed-change@2': Object.freeze({
    id:'ragent-reviewed-change', version:2,
    source:'docs/factory-runtime/phase-4-delivery.zh.md',
    roles:['writer','reviewer'], capabilities:['read','write','review'],
    rules:[
      {key:'implementation',kind:'execution',role:'writer',criteria:['candidate-frozen'],independentReview:true},
      {key:'review',kind:'review',role:'reviewer',criteria:['review-recorded'],dependsOn:{key:'implementation',milestone:'candidate_ready'}},
      {key:'integration',kind:'integration',role:'writer',criteria:['integration-recorded'],dependsOn:{key:'review',milestone:'accepted'}},
    ],
  }),
  'ragent-reviewed-change@3': Object.freeze({
    id:'ragent-reviewed-change', version:3,
    source:'docs/ragent-2.0-autonomy/phase-a-execution-closure.zh.md',
    roles:['writer','reviewer'], capabilities:['read','write','review'],
    rules:[
      {key:'implementation',kind:'execution',role:'writer',criteria:['candidate-frozen','registered-check'],independentReview:true},
      {key:'review',kind:'review',role:'reviewer',criteria:['review-recorded'],dependsOn:{key:'implementation',milestone:'candidate_ready'}},
      {key:'integration',kind:'integration',role:'writer',criteria:['integration-recorded'],dependsOn:{key:'review',milestone:'accepted'}},
    ],
  }),
});
function invalid(message) { throw factoryError('FACTORY_INVALID',message,400); }
function string(v,name) { if (typeof v!=='string'||!v.trim()||v.length>1024) invalid(`${name} is required`); return v.trim(); }
function safePath(v) { string(v,'path'); if (/^(?:[A-Za-z]:|[\\/])/.test(v)||v.split(/[\\/]/).some(s=>s==='..'||s==='.'||!s)) invalid('Paths must be normalized project-relative paths'); return v; }
function safeBranch(v) { string(v,'targetBranch'); if (v.startsWith('-')||v.includes('..')||/[\s~^:?*\[\\]/.test(v)||v.endsWith('/')||v.includes('@{')) invalid('Invalid target branch'); return v; }
export function getFactoryFormula(id,version=1) { const f=FORMULAS[`${id}@${version}`]; if (!f) throw factoryError('FACTORY_NOT_FOUND','Formula version not found',404); return {...structuredClone(f),digest:digest(f)}; }
export function compileFactoryWorkflow({templateId,templateVersion=1,organizationId,projectId,objective,targetBranch,allowedPaths,candidateScope,maxAttempts,maxCost,checkActionId,resource}={}) {
  const formula=getFactoryFormula(templateId,templateVersion); string(organizationId,'organizationId'); string(projectId,'projectId'); string(objective,'objective');
  const report=['ragent-project-report','ragent-responsibility-planner'].includes(templateId) && templateVersion===1;
  if(report) { if(!resource || resource.projectId!==projectId || resource.readScope!=='entire_project' || !['deny','inherit_existing_permissions'].includes(resource.networkPolicy) || Object.keys(resource).sort().join(',')!=='networkPolicy,projectId,readScope') invalid('Explicit whole-project read and network authority is required'); }
  else { safeBranch(targetBranch); if (!Array.isArray(allowedPaths)||!allowedPaths.length) invalid('allowedPaths are required'); allowedPaths.forEach(safePath); safePath(candidateScope); if (!allowedPaths.some(path=>candidateScope===path || candidateScope.startsWith(path+'/'))) invalid('candidateScope must be within an allowed path'); }
  if (!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10) invalid('maxAttempts must be between 1 and 10'); if (!Number.isFinite(maxCost)||maxCost<=0) invalid('A positive cost budget is required');
  const reservationCost=maxCost/(formula.rules.length*maxAttempts); if (!Number.isFinite(reservationCost)||reservationCost<=0) invalid('Cost budget is too small to reserve');
  if (templateId==='ragent-reviewed-change' && templateVersion===3) string(checkActionId,'checkActionId');
  if(report) { const input={organizationId,projectId,objective,resource,maxAttempts,maxCost}; return {schemaVersion:1,templateId:formula.id,templateVersion:formula.version,templateDigest:formula.digest,inputDigest:digest(input),goal:{organizationId,projectId,objective},resources:{roles:formula.roles,capabilities:formula.capabilities,maxAttempts,maxCost},workItems:formula.rules.map(rule=>({key:rule.key,kind:rule.kind,requiredRole:rule.role,contract:{objective,requiredRole:rule.role,acceptanceCriteria:rule.criteria.map(id=>({id,method:'manual'})),accessMode:'read',allowedPaths:[],resource,retry:{maxAttempts},budget:{maxCost},budgetReservation:{cost:reservationCost}},dependencies:[]}))}; }
  const input={organizationId,projectId,objective,targetBranch,allowedPaths:[...allowedPaths],candidateScope,maxAttempts,maxCost,...(templateVersion===3?{checkActionId}:{})};
  return {schemaVersion:1,templateId:formula.id,templateVersion:formula.version,templateDigest:formula.digest,inputDigest:digest(input),goal:{organizationId,projectId,objective},resources:{roles:formula.roles,capabilities:formula.capabilities,maxAttempts,maxCost},workItems:formula.rules.map(rule=>({key:rule.key,kind:rule.kind,requiredRole:rule.role,contract:{objective,requiredRole:rule.role,...(rule.independentReview?{independentReview:true}:{}),acceptanceCriteria:rule.criteria.map(id=>({id,...(id==='registered-check'?{method:'check',actionId:checkActionId}:id==='integration-recorded'?{}:{method:'manual'})})),allowedPaths:[...allowedPaths],accessMode:rule.kind==='review'?'read':'write',targetBranch,candidateScope,retry:{maxAttempts},budget:{maxCost},budgetReservation:{cost:reservationCost}},dependencies:rule.dependsOn?[{predecessorKey:rule.dependsOn.key,milestone:rule.dependsOn.milestone}]:[]}))};
}

// Model output can select only frozen owner catalog entries and ordering; it
// cannot supply command text, resources, limits or a new execution authority.
export function compileFactoryPlanSteps({plan,policy,organizationId,projectId,objective}) {
  if(plan?.schemaVersion!==1 || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length>16 || !Array.isArray(policy?.planCatalog)) invalid('Invalid bounded plan');
  if(!Number.isFinite(policy.planExecutionMaxCost) || policy.planExecutionMaxCost<=0 || !Number.isSafeInteger(policy.planExecutionMaxAttempts) || policy.planExecutionMaxAttempts<1) invalid('Plan execution limits are required');
  const byId=new Map(), entries=[];
  for(const step of plan.steps) {
    if(!step || Object.keys(step).sort().join(',')!=='dependsOn,entryDigest,entryId,id,nodeBindings,templateDigest,templateId,templateVersion' || typeof step.id!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(step.id) || byId.has(step.id) || typeof step.entryId!=='string' || !step.entryId || typeof step.entryDigest!=='string' || !step.entryDigest || !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size!==step.dependsOn.length) invalid('Invalid plan step');
    const matches=policy.planCatalog.filter(e=>e.entryId===step.entryId);
    if(matches.length!==1) invalid('Step is not in the authorized catalog');
    const {entryDigest,...entryContents}=matches[0];
    if(entryDigest!==step.entryDigest || digest(entryContents)!==entryDigest || matches[0].templateId!==step.templateId || matches[0].templateVersion!==step.templateVersion || matches[0].templateDigest!==step.templateDigest || digest(matches[0].nodeBindings)!==digest(step.nodeBindings)) invalid('Catalog entry identity changed');
    const catalog=matches[0], proposal=compileFactoryWorkflow({...catalog,organizationId,projectId,objective});
    if(proposal.templateDigest!==step.templateDigest) invalid('Plan template changed');
    const entry={step,catalog,proposal}; byId.set(step.id,entry); entries.push(entry);
  }
  const order=[], active=new Set(), done=new Set();
  function visit(id) { if(active.has(id)) invalid('Plan contains a cycle'); if(done.has(id)) return; const entry=byId.get(id); if(!entry) invalid('Plan dependency does not exist'); active.add(id); for(const dependency of entry.step.dependsOn) { if(typeof dependency!=='string') invalid('Invalid dependency'); visit(dependency); } active.delete(id); done.add(id); order.push(entry); }
  for(const {step} of entries) visit(step.id);
  if(entries.reduce((sum,e)=>sum+e.catalog.maxCost,0)>policy.planExecutionMaxCost || entries.reduce((sum,e)=>sum+e.catalog.maxAttempts,0)>policy.planExecutionMaxAttempts) invalid('Plan exceeds execution limits');
  return order;
}

// The proposal is regenerated on the server and all graph facts are committed
// together. It never assigns an executor, approves contracts, or launches work.
export async function instantiateFactoryWorkflow(input,actor) {
  const proposal=compileFactoryWorkflow(input); const commandId=required(input.commandId,'commandId'), key=required(input.idempotencyKey,'idempotencyKey'), actorId=required(actor?.principalId,'authenticated principal');
  const payloadDigest=digest({templateId:proposal.templateId,templateVersion:proposal.templateVersion,inputDigest:proposal.inputDigest});
  return factoryTransaction(db=>{ const org=authorize(db,proposal.goal.organizationId,actor,'factory.CreateWorkItem'); if (org.project_id!==proposal.goal.projectId) throw factoryError('FACTORY_CONFLICT','Project does not match organization'); const existing=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actorId,'InstantiateWorkflow',proposal.goal.organizationId,key); if (existing) { if (existing.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Idempotency key reused with different inputs'); return {...JSON.parse(existing.result_json),replayed:true}; } if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const result=instantiateFactoryWorkflowInTransaction(db,proposal,org,commandId);
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,proposal.goal.organizationId,actorId,'InstantiateWorkflow',proposal.goal.organizationId,key,payloadDigest,encode(result),now()); return result; });
}

// Both owner instantiation and restricted admission share the template writer.
// The caller owns the transaction and must authorize all supplied assignments.
export function instantiateFactoryWorkflowInTransaction(db,proposal,org,commandId,{assignments=null}={}) {
  const ts=now(), goalId=newId('goal'), instanceId=newId('workflow');
  db.prepare('INSERT INTO factory_goals (id,organization_id,project_id,parent_goal_id,body_json,revision,row_version,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(goalId,proposal.goal.organizationId,proposal.goal.projectId,null,encode({objective:proposal.goal.objective,acceptanceBaseline:[]}),1,1,'active',ts,ts);
  const mapping={};
  for (const spec of proposal.workItems) {
    const id=newId('work'); mapping[spec.key]=id;
    const state=assignments ? (spec.dependencies.length ? 'blocked' : 'ready') : 'proposed';
    const blocked=state==='blocked'?encode({code:'dependencies',predecessors:[]}):null;
    db.prepare('INSERT INTO factory_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,goalId,proposal.goal.organizationId,proposal.goal.projectId,spec.kind,'active',state,'none',0,assignments?.[spec.key]?.nodeId||null,1,1,0,0,blocked,encode({workflowInstanceId:instanceId,templateKey:spec.key}),null,0,ts,ts);
    const contract={...spec.contract,organizationRevision:org.current_revision};
    db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(id,1,encode(contract),digest(contract),ts);
  }
  for (const spec of proposal.workItems) {
    for (const edge of spec.dependencies) db.prepare('INSERT INTO factory_dependencies VALUES(?,?,?,?,?)').run(mapping[edge.predecessorKey],mapping[spec.key],edge.milestone,null,ts);
    if (assignments && spec.dependencies.length) db.prepare('UPDATE factory_work_items SET blocked_json=? WHERE id=?').run(encode({code:'dependencies',predecessors:spec.dependencies.map(edge=>mapping[edge.predecessorKey])}),mapping[spec.key]);
  }
  db.prepare('INSERT INTO factory_workflow_instances VALUES(?,?,?,?,?,?,?,?,?)').run(instanceId,proposal.goal.organizationId,goalId,proposal.templateId,proposal.templateVersion,proposal.templateDigest,proposal.inputDigest,encode(mapping),ts);
  event(db,proposal.goal.organizationId,goalId,'WorkflowInstantiated',{instanceId,templateId:proposal.templateId,templateVersion:proposal.templateVersion,templateDigest:proposal.templateDigest,inputDigest:proposal.inputDigest,mapping});
  return {schemaVersion:1,operation:{commandId,state:'completed'},instance:{id:instanceId,templateId:proposal.templateId,templateVersion:proposal.templateVersion,templateDigest:proposal.templateDigest,inputDigest:proposal.inputDigest,mapping},goal:goalRow(db.prepare('SELECT * FROM factory_goals WHERE id=?').get(goalId)),items:Object.values(mapping).map(id=>itemRow(db,db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(id)))};
}

// ---------------------------------------------------------------------------
// Deterministic Fan-Out Formulas (parallel / pipeline / phase)
// ---------------------------------------------------------------------------
const FANOUT_MAX_CONCURRENCY = 16;
const FANOUT_MAX_STEPS = 256;
const FANOUT_MAX_ITEMS = 128;
const FANOUT_MILESTONES = new Set(['accepted', 'candidate_ready', 'integrated']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function escalate(message, details = {}) {
  throw factoryError('FANOUT_PRIVILEGE_ESCALATION', message, 403, details);
}

function safeKey(value, name = 'key') {
  const s = string(value, name);
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(s)) invalid(`${name} contains invalid characters`);
  return s;
}

function normalizePathSlashes(p) {
  return safePath(p).replace(/\\/g, '/');
}

function normalizeAllowedPathsList(list, label = 'allowedPaths') {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) invalid(`${label} must be an array`);
  return [...new Set(list.map(normalizePathSlashes))];
}

function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isPathCoveredBy(candidatePath, allowedCaps) {
  return allowedCaps.some((cap) => candidatePath === cap || candidatePath.startsWith(`${cap}/`));
}

/** Validate that an outputSchema conforms to the supported JSON Schema subset. */
export function assertValidFanoutSchemaDefinition(schema, path = '$') {
  if (schema === undefined || schema === null) return;
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    invalid(`Invalid outputSchema at ${path}: schema must be an object`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((t) => typeof t !== 'string' || !SCHEMA_TYPES.has(t))) {
      invalid(`Invalid outputSchema type at ${path}`);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string' || !r)) {
      invalid(`Invalid outputSchema.required at ${path}`);
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      invalid(`Invalid outputSchema.enum at ${path}`);
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    invalid(`Invalid outputSchema.additionalProperties at ${path}`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      invalid(`Invalid outputSchema.properties at ${path}`);
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      assertValidFanoutSchemaDefinition(sub, `${path}.${k}`);
    }
  }
  if (schema.items !== undefined) {
    assertValidFanoutSchemaDefinition(schema.items, `${path}[]`);
  }
}

function normalizeMilestone(milestone) {
  const m = milestone === undefined ? 'accepted' : milestone;
  if (typeof m !== 'string' || !FANOUT_MILESTONES.has(m)) {
    invalid(`Invalid milestone '${String(m)}'`);
  }
  return m;
}

function normalizeConcurrency(value, fallback = 4) {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || n < 1 || n > FANOUT_MAX_CONCURRENCY) {
    invalid(`maxConcurrency must be an integer between 1 and ${FANOUT_MAX_CONCURRENCY}`);
  }
  return n;
}

function interpolateTemplateValue(template, item, index) {
  if (typeof template === 'string') {
    return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, expr) => {
      if (expr === 'index') return String(index);
      if (expr === 'item') return typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? String(item) : JSON.stringify(item);
      if (expr.startsWith('item.') && item && typeof item === 'object') {
        const key = expr.slice(5);
        if (Object.hasOwn(item, key) && ['string', 'number', 'boolean'].includes(typeof item[key])) {
          return String(item[key]);
        }
      }
      return '';
    });
  }
  if (Array.isArray(template)) return template.map((entry) => interpolateTemplateValue(entry, item, index));
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = interpolateTemplateValue(v, item, index);
    }
    return out;
  }
  return template;
}

function normalizeStepDescriptor(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Fan-out step must be an object');
  const key = raw.key !== undefined ? safeKey(raw.key, 'step.key') : defaults.key ? safeKey(defaults.key, 'step.key') : null;
  const accessMode = raw.accessMode ?? defaults.accessMode ?? 'read';
  if (!['read', 'write'].includes(accessMode)) invalid(`Invalid step accessMode '${String(accessMode)}'`);
  const allowedPaths = raw.allowedPaths !== undefined
    ? normalizeAllowedPathsList(raw.allowedPaths, 'step.allowedPaths')
    : (defaults.allowedPaths !== undefined ? [...defaults.allowedPaths] : undefined);
  const outputSchema = raw.outputSchema !== undefined ? raw.outputSchema : defaults.outputSchema;
  if (outputSchema !== undefined) assertValidFanoutSchemaDefinition(outputSchema);
  const objective = typeof raw.objective === 'string' && raw.objective.trim()
    ? raw.objective.trim()
    : (typeof raw.prompt === 'string' && raw.prompt.trim()
      ? raw.prompt.trim()
      : (typeof defaults.objective === 'string' && defaults.objective.trim() ? defaults.objective.trim() : ''));
  if (!objective) invalid('Each fan-out step requires an objective or prompt');
  const budgetCost = raw.budgetCost !== undefined ? raw.budgetCost : defaults.budgetCost;
  if (budgetCost !== undefined && (!Number.isFinite(budgetCost) || budgetCost <= 0)) {
    invalid('step budgetCost must be a positive number');
  }
  const kind = raw.stepKind || (raw.kind && raw.kind !== 'fanout_step' ? raw.kind : '') || defaults.kind || 'execution';
  if (!['execution', 'review', 'integration'].includes(kind)) invalid(`Invalid step kind '${String(kind)}'`);
  const requiredRole = raw.requiredRole || defaults.requiredRole || (accessMode === 'write' ? 'writer' : 'specialist');
  return {
    kind: 'fanout_step',
    stepKind: kind,
    ...(key ? { key } : {}),
    objective,
    prompt: typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim() : objective,
    requiredRole: string(requiredRole, 'requiredRole'),
    accessMode,
    ...(allowedPaths !== undefined ? { allowedPaths } : {}),
    ...(outputSchema !== undefined ? { outputSchema: structuredClone(outputSchema) } : {}),
    ...(raw.item !== undefined ? { item: structuredClone(raw.item) } : (defaults.item !== undefined ? { item: structuredClone(defaults.item) } : {})),
    ...(Number.isInteger(raw.itemIndex) ? { itemIndex: raw.itemIndex } : (Number.isInteger(defaults.itemIndex) ? { itemIndex: defaults.itemIndex } : {})),
    ...(budgetCost !== undefined ? { budgetCost } : {}),
    ...(Array.isArray(raw.dependsOnKeys) ? { dependsOnKeys: [...raw.dependsOnKeys] } : {}),
    ...(Array.isArray(raw.inputFromKeys) ? { inputFromKeys: [...raw.inputFromKeys] } : {}),
    ...(raw.milestone ? { milestone: normalizeMilestone(raw.milestone) } : {}),
  };
}

function assertParallelWritersNonOverlapping(steps, label = 'parallel') {
  const writers = steps.filter((s) => s.accessMode === 'write');
  if (writers.length <= 1) return;
  for (let i = 0; i < writers.length; i += 1) {
    const pathsA = writers[i].allowedPaths || [];
    if (pathsA.length === 0) {
      throw factoryError('FANOUT_WRITER_PATH_OVERLAP', `Parallel writer steps in '${label}' require explicit non-overlapping allowedPaths`, 400);
    }
    for (let j = i + 1; j < writers.length; j += 1) {
      const pathsB = writers[j].allowedPaths || [];
      if (pathsB.length === 0) {
        throw factoryError('FANOUT_WRITER_PATH_OVERLAP', `Parallel writer steps in '${label}' require explicit non-overlapping allowedPaths`, 400);
      }
      for (const a of pathsA) {
        for (const b of pathsB) {
          if (pathsOverlap(a, b)) {
            throw factoryError('FANOUT_WRITER_PATH_OVERLAP', `Parallel writer paths '${a}' and '${b}' overlap in '${label}'`, 400, { pathA: a, pathB: b });
          }
        }
      }
    }
  }
}

/** Deterministic stage barrier grouping steps whose predecessors must settle before downstream phases begin. */
export function phase(name, steps, options = {}) {
  const phaseName = string(name, 'phase name');
  const rawSteps = Array.isArray(steps)
    ? steps
    : (steps && typeof steps === 'object' && !Array.isArray(steps) ? [steps] : null);
  if (!rawSteps || rawSteps.length === 0) invalid(`phase '${phaseName}' requires a non-empty steps array`);
  if (rawSteps.length > FANOUT_MAX_STEPS) invalid(`phase '${phaseName}' exceeds ${FANOUT_MAX_STEPS} steps`);
  const milestone = normalizeMilestone(options.milestone);
  if (options.outputSchema !== undefined) assertValidFanoutSchemaDefinition(options.outputSchema);
  const maxConcurrency = options.maxConcurrency !== undefined ? normalizeConcurrency(options.maxConcurrency) : undefined;
  const allowedPaths = options.allowedPaths !== undefined ? normalizeAllowedPathsList(options.allowedPaths, 'phase.allowedPaths') : undefined;
  return {
    kind: 'fanout_phase',
    name: phaseName,
    key: safeKey(phaseName.replace(/\s+/g, '_'), 'phase.key'),
    milestone,
    steps: rawSteps.map((entry) => entry),
    ...(options.outputSchema !== undefined ? { outputSchema: structuredClone(options.outputSchema) } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(options.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(allowedPaths !== undefined ? { allowedPaths } : {}),
    ...(options.requiredRole ? { requiredRole: string(options.requiredRole, 'requiredRole') } : {}),
    ...(options.kind ? { stepKind: options.kind } : {}),
  };
}

/** Deterministic bounded fan-out over an explicit array of items with non-overlapping writer validation. */
export function parallel(items, itemStepBuilder, options = {}) {
  if (!Array.isArray(items) || items.length === 0) invalid('parallel requires a non-empty items array');
  if (items.length > FANOUT_MAX_ITEMS) invalid(`parallel cannot exceed ${FANOUT_MAX_ITEMS} items`);
  if (typeof itemStepBuilder !== 'function' && (!itemStepBuilder || typeof itemStepBuilder !== 'object' || Array.isArray(itemStepBuilder))) {
    invalid('parallel requires a builder function or step template object');
  }
  const groupName = string(options.name || 'parallel', 'parallel name');
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency, 4);
  const milestone = normalizeMilestone(options.milestone);
  if (options.outputSchema !== undefined) assertValidFanoutSchemaDefinition(options.outputSchema);
  const defaultAllowedPaths = options.allowedPaths !== undefined ? normalizeAllowedPathsList(options.allowedPaths, 'parallel.allowedPaths') : undefined;
  const steps = items.map((item, index) => {
    const raw = typeof itemStepBuilder === 'function'
      ? itemStepBuilder(item, index, { index, total: items.length, groupName })
      : interpolateTemplateValue(itemStepBuilder, item, index);
    return normalizeStepDescriptor(raw, {
      key: `${groupName.replace(/\s+/g, '_')}_${index}`,
      outputSchema: options.outputSchema,
      accessMode: options.accessMode,
      allowedPaths: defaultAllowedPaths,
      requiredRole: options.requiredRole,
      kind: options.kind,
      item,
      itemIndex: index,
    });
  });
  assertParallelWritersNonOverlapping(steps, groupName);
  return {
    kind: 'fanout_parallel',
    name: groupName,
    key: safeKey(groupName.replace(/\s+/g, '_'), 'parallel.key'),
    maxConcurrency,
    milestone,
    steps,
    ...(options.outputSchema !== undefined ? { outputSchema: structuredClone(options.outputSchema) } : {}),
    ...(options.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(defaultAllowedPaths !== undefined ? { allowedPaths: defaultAllowedPaths } : {}),
  };
}

/** Sequential pipeline chaining validated outputs from stage i into stage i+1. */
export function pipeline(stages, options = {}) {
  if (!Array.isArray(stages) || stages.length === 0) invalid('pipeline requires a non-empty stages array');
  if (stages.length > FANOUT_MAX_STEPS) invalid(`pipeline exceeds ${FANOUT_MAX_STEPS} stages`);
  const pipeName = string(options.name || 'pipeline', 'pipeline name');
  const milestone = normalizeMilestone(options.milestone);
  if (options.outputSchema !== undefined) assertValidFanoutSchemaDefinition(options.outputSchema);
  const allowedPaths = options.allowedPaths !== undefined ? normalizeAllowedPathsList(options.allowedPaths, 'pipeline.allowedPaths') : undefined;
  return {
    kind: 'fanout_pipeline',
    name: pipeName,
    key: safeKey(pipeName.replace(/\s+/g, '_'), 'pipeline.key'),
    milestone,
    stages: stages.map((entry) => entry),
    ...(options.outputSchema !== undefined ? { outputSchema: structuredClone(options.outputSchema) } : {}),
    ...(options.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(allowedPaths !== undefined ? { allowedPaths } : {}),
  };
}

function hydrateDeclarativeNode(node, defaults = {}) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) invalid('Fan-out node must be an object');
  const kind = node.kind || (Array.isArray(node.stages) ? 'fanout_pipeline' : Array.isArray(node.items) ? 'fanout_parallel' : Array.isArray(node.steps) ? 'fanout_phase' : 'fanout_step');
  if (kind === 'fanout_parallel' || kind === 'parallel') {
    if (Array.isArray(node.steps) && !Array.isArray(node.items)) {
      const groupName = string(node.name || defaults.name || 'parallel', 'parallel name');
      const maxConcurrency = normalizeConcurrency(node.maxConcurrency, defaults.maxConcurrency ?? 4);
      const milestone = normalizeMilestone(node.milestone ?? defaults.milestone);
      const groupSteps = node.steps.map((s, idx) => normalizeStepDescriptor(s, {
        ...defaults,
        key: s?.key || `${groupName.replace(/\s+/g, '_')}_${idx}`,
        outputSchema: node.outputSchema ?? defaults.outputSchema,
        accessMode: node.accessMode ?? defaults.accessMode,
        allowedPaths: node.allowedPaths ?? defaults.allowedPaths,
        itemIndex: Number.isInteger(s?.itemIndex) ? s.itemIndex : idx,
      }));
      assertParallelWritersNonOverlapping(groupSteps, groupName);
      return { kind: 'fanout_parallel', name: groupName, key: safeKey(node.key || groupName.replace(/\s+/g, '_')), maxConcurrency, milestone, steps: groupSteps };
    }
    const builder = node.itemTemplate || node.stepTemplate;
    return parallel(node.items, builder, {
      name: node.name || defaults.name || 'parallel',
      maxConcurrency: node.maxConcurrency ?? defaults.maxConcurrency,
      milestone: node.milestone ?? defaults.milestone,
      outputSchema: node.outputSchema ?? defaults.outputSchema,
      accessMode: node.accessMode ?? defaults.accessMode,
      allowedPaths: node.allowedPaths ?? defaults.allowedPaths,
      requiredRole: node.requiredRole ?? defaults.requiredRole,
      kind: node.stepKind ?? defaults.kind,
    });
  }
  if (kind === 'fanout_phase' || kind === 'phase') {
    return phase(node.name || defaults.name || 'phase', node.steps, {
      milestone: node.milestone ?? defaults.milestone,
      outputSchema: node.outputSchema ?? defaults.outputSchema,
      maxConcurrency: node.maxConcurrency ?? defaults.maxConcurrency,
      accessMode: node.accessMode ?? defaults.accessMode,
      allowedPaths: node.allowedPaths ?? defaults.allowedPaths,
      requiredRole: node.requiredRole ?? defaults.requiredRole,
      kind: node.stepKind ?? defaults.kind,
    });
  }
  if (kind === 'fanout_pipeline' || kind === 'pipeline') {
    return pipeline(node.stages, {
      name: node.name || defaults.name || 'pipeline',
      milestone: node.milestone ?? defaults.milestone,
      outputSchema: node.outputSchema ?? defaults.outputSchema,
      accessMode: node.accessMode ?? defaults.accessMode,
      allowedPaths: node.allowedPaths ?? defaults.allowedPaths,
    });
  }
  return normalizeStepDescriptor(node, defaults);
}

/** Compile composable phase/parallel/pipeline primitives into a standard Factory Work Graph proposal. */
export function compileFactoryFanoutWorkflow(input = {}) {
  const organizationId = string(input.organizationId, 'organizationId');
  const projectId = string(input.projectId, 'projectId');
  const objective = string(input.objective || input.title, 'objective');
  const callerPolicy = input.callerPolicy && typeof input.callerPolicy === 'object' ? input.callerPolicy : {};
  const maxAttempts = input.maxAttempts === undefined ? 1 : input.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) invalid('maxAttempts must be between 1 and 10');

  const ceilingAccessMode = callerPolicy.accessMode ?? input.accessMode ?? 'read';
  if (!['read', 'write'].includes(ceilingAccessMode)) invalid(`Invalid accessMode '${String(ceilingAccessMode)}'`);

  const ceilingAllowedPaths = callerPolicy.allowedPaths !== undefined
    ? normalizeAllowedPathsList(callerPolicy.allowedPaths, 'callerPolicy.allowedPaths')
    : (input.allowedPaths !== undefined ? normalizeAllowedPathsList(input.allowedPaths, 'allowedPaths') : undefined);
  const ceilingMaxConcurrency = normalizeConcurrency(callerPolicy.maxConcurrency ?? input.maxConcurrency, 4);
  const requestedMaxConcurrency = normalizeConcurrency(input.maxConcurrency, ceilingMaxConcurrency);
  if (callerPolicy.maxConcurrency !== undefined && requestedMaxConcurrency > ceilingMaxConcurrency) {
    escalate(`Requested maxConcurrency ${requestedMaxConcurrency} exceeds caller limit ${ceilingMaxConcurrency}`);
  }
  const ceilingMaxCost = callerPolicy.maxCost ?? input.maxCost ?? 10;
  if (!Number.isFinite(ceilingMaxCost) || ceilingMaxCost <= 0) invalid('A positive cost budget is required');
  if (callerPolicy.maxCost !== undefined && input.maxCost !== undefined && input.maxCost > callerPolicy.maxCost) {
    escalate(`Requested maxCost ${input.maxCost} exceeds caller budget ${callerPolicy.maxCost}`);
  }
  const effectiveMaxCost = Math.min(ceilingMaxCost, input.maxCost ?? ceilingMaxCost);
  const ceilingMaxRuns = callerPolicy.maxRuns ?? input.maxRuns;
  if (ceilingMaxRuns !== undefined && (!Number.isInteger(ceilingMaxRuns) || ceilingMaxRuns < 1)) invalid('maxRuns must be a positive integer');

  let rawNodes;
  if (input.pipeline) rawNodes = [hydrateDeclarativeNode(input.pipeline)];
  else if (input.spec) rawNodes = Array.isArray(input.spec) ? input.spec : [hydrateDeclarativeNode(input.spec)];
  else if (Array.isArray(input.phases) && input.phases.length > 0) rawNodes = input.phases;
  else if (Array.isArray(input.stages) && input.stages.length > 0) rawNodes = [pipeline(input.stages)];
  else invalid('phases, stages, pipeline, or spec is required');

  const compiledSteps = [];
  const usedKeys = new Set();
  const phaseSummaries = [];

  function allocUniqueKey(preferred) {
    let candidate = safeKey(preferred, 'step.key');
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
    let suffix = 1;
    while (usedKeys.has(`${candidate}_${suffix}`)) suffix += 1;
    candidate = `${candidate}_${suffix}`;
    usedKeys.add(candidate);
    return candidate;
  }

  function flattenNode(node, ctx) {
    const hydrated = hydrateDeclarativeNode(node, ctx.defaults);
    if (hydrated.kind === 'fanout_step') {
      const key = allocUniqueKey(hydrated.key || `${ctx.phaseKey}_step_${compiledSteps.length}`);
      const deps = [];
      for (const predKey of ctx.upstreamKeys) {
        deps.push({ predecessorKey: predKey, milestone: ctx.upstreamMilestone });
      }
      for (const extraPred of hydrated.dependsOnKeys || []) {
        if (!deps.some((d) => d.predecessorKey === extraPred)) {
          deps.push({ predecessorKey: extraPred, milestone: hydrated.milestone || ctx.upstreamMilestone });
        }
      }
      const step = {
        ...hydrated,
        key,
        phaseKey: ctx.phaseKey,
        phaseIndex: ctx.phaseIndex,
        maxConcurrency: ctx.maxConcurrency,
        ...(ctx.parallelGroupKey ? { parallelGroupKey: ctx.parallelGroupKey } : {}),
        inputFromKeys: [...new Set([...(hydrated.inputFromKeys || []), ...ctx.inputFromKeys])],
        dependencies: deps,
      };
      compiledSteps.push(step);
      if (compiledSteps.length > FANOUT_MAX_STEPS) invalid(`Fan-out workflow exceeds ${FANOUT_MAX_STEPS} total steps`);
      return [key];
    }

    if (hydrated.kind === 'fanout_parallel') {
      const groupKey = hydrated.key || `${ctx.phaseKey}_parallel_${ctx.phaseIndex}`;
      const groupMaxConcurrency = Math.min(hydrated.maxConcurrency || ctx.maxConcurrency, ceilingMaxConcurrency);
      if (callerPolicy.maxConcurrency !== undefined && (hydrated.maxConcurrency || 1) > ceilingMaxConcurrency) {
        escalate(`Parallel group '${hydrated.name}' maxConcurrency exceeds caller limit ${ceilingMaxConcurrency}`);
      }
      const leaves = [];
      const groupSteps = [];
      for (const rawStep of hydrated.steps) {
        const outKeys = flattenNode(rawStep, {
          ...ctx,
          maxConcurrency: groupMaxConcurrency,
          parallelGroupKey: groupKey,
          defaults: {
            ...ctx.defaults,
            outputSchema: rawStep.outputSchema ?? hydrated.outputSchema ?? ctx.defaults.outputSchema,
            accessMode: rawStep.accessMode ?? hydrated.accessMode ?? ctx.defaults.accessMode,
            allowedPaths: rawStep.allowedPaths ?? hydrated.allowedPaths ?? ctx.defaults.allowedPaths,
          },
        });
        leaves.push(...outKeys);
        groupSteps.push(compiledSteps[compiledSteps.length - 1]);
      }
      assertParallelWritersNonOverlapping(groupSteps, hydrated.name);
      return leaves;
    }

    if (hydrated.kind === 'fanout_pipeline') {
      let prevKeys = [...ctx.upstreamKeys];
      let prevMilestone = ctx.upstreamMilestone;
      for (let i = 0; i < hydrated.stages.length; i += 1) {
        const stage = hydrateDeclarativeNode(hydrated.stages[i], {
          ...ctx.defaults,
          name: `${hydrated.name}_stage_${i}`,
          outputSchema: hydrated.outputSchema ?? ctx.defaults.outputSchema,
          accessMode: hydrated.accessMode ?? ctx.defaults.accessMode,
          allowedPaths: hydrated.allowedPaths ?? ctx.defaults.allowedPaths,
        });
        const stageLeaves = flattenNode(stage, {
          ...ctx,
          upstreamKeys: prevKeys,
          upstreamMilestone: prevMilestone,
          inputFromKeys: i > 0 ? [...prevKeys] : ctx.inputFromKeys,
          defaults: {
            ...ctx.defaults,
            outputSchema: stage.outputSchema ?? hydrated.outputSchema ?? ctx.defaults.outputSchema,
            accessMode: stage.accessMode ?? hydrated.accessMode ?? ctx.defaults.accessMode,
            allowedPaths: stage.allowedPaths ?? hydrated.allowedPaths ?? ctx.defaults.allowedPaths,
          },
        });
        prevKeys = stageLeaves;
        prevMilestone = stage.milestone || hydrated.milestone || 'accepted';
      }
      return prevKeys;
    }

    // fanout_phase
    const pIndex = phaseSummaries.length;
    const pKey = hydrated.key;
    const pConcurrency = Math.min(hydrated.maxConcurrency ?? requestedMaxConcurrency, ceilingMaxConcurrency);
    if (callerPolicy.maxConcurrency !== undefined && hydrated.maxConcurrency !== undefined && hydrated.maxConcurrency > ceilingMaxConcurrency) {
      escalate(`Phase '${hydrated.name}' maxConcurrency exceeds caller limit ${ceilingMaxConcurrency}`);
    }
    const phaseStart = compiledSteps.length;
    const phaseOutKeys = [];
    for (const child of hydrated.steps) {
      const childOut = flattenNode(child, {
        phaseKey: pKey,
        phaseIndex: pIndex,
        maxConcurrency: pConcurrency,
        parallelGroupKey: '',
        upstreamKeys: ctx.upstreamKeys,
        upstreamMilestone: ctx.upstreamMilestone,
        inputFromKeys: ctx.inputFromKeys,
        defaults: {
          outputSchema: hydrated.outputSchema ?? ctx.defaults.outputSchema,
          accessMode: hydrated.accessMode ?? ctx.defaults.accessMode,
          allowedPaths: hydrated.allowedPaths ?? ctx.defaults.allowedPaths,
          requiredRole: hydrated.requiredRole ?? ctx.defaults.requiredRole,
          kind: hydrated.stepKind ?? ctx.defaults.kind,
        },
      });
      phaseOutKeys.push(...childOut);
    }
    const phaseSteps = compiledSteps.slice(phaseStart);
    assertParallelWritersNonOverlapping(phaseSteps, hydrated.name);
    phaseSummaries.push({
      key: pKey,
      name: hydrated.name,
      index: pIndex,
      milestone: hydrated.milestone,
      maxConcurrency: pConcurrency,
      stepKeys: phaseSteps.map((s) => s.key),
    });
    return phaseOutKeys;
  }

  let barrierKeys = [];
  let barrierMilestone = 'accepted';
  function runTopNode(rawNode, label, defaults = {}) {
    const top = hydrateDeclarativeNode(rawNode, { name: label, ...defaults });
    if (top.kind === 'fanout_pipeline') {
      const inherited = {
        ...(top.outputSchema !== undefined ? { outputSchema: top.outputSchema } : defaults.outputSchema !== undefined ? { outputSchema: defaults.outputSchema } : {}),
        ...(top.accessMode !== undefined ? { accessMode: top.accessMode } : defaults.accessMode !== undefined ? { accessMode: defaults.accessMode } : {}),
        ...(top.allowedPaths !== undefined ? { allowedPaths: top.allowedPaths } : defaults.allowedPaths !== undefined ? { allowedPaths: defaults.allowedPaths } : {}),
      };
      for (let s = 0; s < top.stages.length; s += 1) {
        runTopNode(top.stages[s], `${top.name}_stage_${s}`, inherited);
      }
      return;
    }
    const targetPhase = top.kind === 'fanout_phase'
      ? top
      : phase(label, [top], { milestone: top.milestone || defaults.milestone || 'accepted', ...defaults });
    barrierKeys = flattenNode(targetPhase, {
      phaseKey: targetPhase.key,
      phaseIndex: phaseSummaries.length,
      maxConcurrency: requestedMaxConcurrency,
      parallelGroupKey: '',
      upstreamKeys: barrierKeys,
      upstreamMilestone: barrierMilestone,
      inputFromKeys: barrierKeys,
      defaults,
    });
    barrierMilestone = targetPhase.milestone;
  }
  for (let i = 0; i < rawNodes.length; i += 1) {
    runTopNode(rawNodes[i], `phase_${i}`);
  }

  // Enforce strict no-privilege-escalation and budget invariants across all compiled steps
  const anyWrite = compiledSteps.some((s) => s.accessMode === 'write');
  if (anyWrite && input.targetBranch !== undefined) safeBranch(input.targetBranch);
  if (anyWrite && input.candidateScope !== undefined) normalizePathSlashes(input.candidateScope);

  if (ceilingMaxRuns !== undefined && compiledSteps.length * maxAttempts > ceilingMaxRuns) {
    escalate(`Workflow run capacity ${compiledSteps.length * maxAttempts} exceeds caller limit ${ceilingMaxRuns}`);
  }

  let explicitCostSum = 0;
  let explicitCostCount = 0;
  for (const step of compiledSteps) {
    if (step.accessMode === 'write' && ceilingAccessMode !== 'write') {
      escalate(`Step '${step.key}' requests write accessMode under read-only caller policy`);
    }
    if (step.allowedPaths !== undefined) {
      if (ceilingAllowedPaths !== undefined) {
        const allowEntireProjectRead = step.accessMode === 'read'
          && input.resource?.readScope === 'entire_project'
          && callerPolicy.allowedPaths === undefined
          && callerPolicy.allowEntireProjectRead === true;
        if (!allowEntireProjectRead) {
          for (const p of step.allowedPaths) {
            if (!isPathCoveredBy(p, ceilingAllowedPaths)) {
              escalate(`Step '${step.key}' path '${p}' exceeds caller allowedPaths`, { stepKey: step.key, path: p });
            }
          }
        }
      }
    } else {
      step.allowedPaths = ceilingAllowedPaths !== undefined ? [...ceilingAllowedPaths] : [];
    }
    if (step.accessMode === 'write' && step.allowedPaths.length === 0) {
      invalid(`Write step '${step.key}' requires non-empty allowedPaths`);
    }
    if (step.budgetCost !== undefined) {
      explicitCostSum += step.budgetCost;
      explicitCostCount += 1;
    }
  }
  if (explicitCostSum > effectiveMaxCost) {
    escalate(`Explicit step budget total ${explicitCostSum} exceeds caller maxCost ${effectiveMaxCost}`);
  }

  // Re-verify parallel writer path non-overlap after ceiling path inheritance
  const byParallelGroup = new Map();
  for (const step of compiledSteps) {
    if (!step.parallelGroupKey) continue;
    if (!byParallelGroup.has(step.parallelGroupKey)) byParallelGroup.set(step.parallelGroupKey, []);
    byParallelGroup.get(step.parallelGroupKey).push(step);
  }
  for (const [groupKey, groupSteps] of byParallelGroup.entries()) {
    assertParallelWritersNonOverlapping(groupSteps, groupKey);
  }

  // Verify DAG topology & cycle absence
  const stepByKey = new Map(compiledSteps.map((s) => [s.key, s]));
  const visiting = new Set();
  const visited = new Set();
  function checkDag(k) {
    if (visiting.has(k)) invalid(`Cycle detected at step '${k}'`);
    if (visited.has(k)) return;
    const node = stepByKey.get(k);
    if (!node) invalid(`Missing dependency step '${k}'`);
    visiting.add(k);
    for (const dep of node.dependencies) checkDag(dep.predecessorKey);
    visiting.delete(k);
    visited.add(k);
  }
  for (const step of compiledSteps) checkDag(step.key);

  const remainingBudget = Math.max(0, effectiveMaxCost - explicitCostSum);
  const unpricedCount = compiledSteps.length - explicitCostCount;
  const defaultStepCost = unpricedCount > 0 ? remainingBudget / (unpricedCount * maxAttempts) : effectiveMaxCost / (compiledSteps.length * maxAttempts);
  if (unpricedCount > 0 && (!Number.isFinite(defaultStepCost) || defaultStepCost <= 0)) {
    invalid('Cost budget is too small to reserve fan-out steps');
  }

  const workItems = compiledSteps.map((step) => {
    const reservationCost = step.budgetCost !== undefined ? step.budgetCost / maxAttempts : defaultStepCost;
    const contract = {
      objective: step.objective,
      prompt: step.prompt,
      requiredRole: step.requiredRole,
      acceptanceCriteria: [{ id: 'fanout-completed', method: 'manual' }],
      allowedPaths: [...step.allowedPaths],
      accessMode: step.accessMode,
      phaseKey: step.phaseKey,
      phaseIndex: step.phaseIndex,
      ...(step.parallelGroupKey ? { parallelGroupKey: step.parallelGroupKey } : {}),
      ...(Number.isInteger(step.itemIndex) ? { itemIndex: step.itemIndex } : {}),
      ...(step.item !== undefined ? { item: step.item } : {}),
      ...(step.inputFromKeys.length ? { inputFromKeys: step.inputFromKeys } : {}),
      ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
      ...(anyWrite && input.targetBranch ? { targetBranch: safeBranch(input.targetBranch) } : {}),
      ...(anyWrite && input.candidateScope ? { candidateScope: normalizePathSlashes(input.candidateScope) } : {}),
      retry: { maxAttempts },
      budget: { maxCost: effectiveMaxCost },
      budgetReservation: { cost: reservationCost },
    };
    return {
      key: step.key,
      kind: step.stepKind,
      requiredRole: step.requiredRole,
      phaseKey: step.phaseKey,
      phaseIndex: step.phaseIndex,
      maxConcurrency: step.maxConcurrency,
      ...(step.parallelGroupKey ? { parallelGroupKey: step.parallelGroupKey } : {}),
      ...(Number.isInteger(step.itemIndex) ? { itemIndex: step.itemIndex } : {}),
      ...(step.item !== undefined ? { item: step.item } : {}),
      inputFromKeys: step.inputFromKeys,
      contract,
      dependencies: step.dependencies,
    };
  });

  const formulaMetadata = { id: 'ragent-fanout-workflow', version: 1, capabilities: anyWrite ? ['read', 'write'] : ['read'] };
  const templateDigest = digest(formulaMetadata);
  const inputDigest = digest({
    organizationId,
    projectId,
    objective,
    maxAttempts,
    maxCost: effectiveMaxCost,
    maxConcurrency: requestedMaxConcurrency,
    workItems,
  });

  return {
    schemaVersion: 1,
    templateId: formulaMetadata.id,
    templateVersion: formulaMetadata.version,
    templateDigest,
    inputDigest,
    goal: { organizationId, projectId, objective },
    resources: {
      roles: [...new Set(workItems.map((w) => w.requiredRole))],
      capabilities: formulaMetadata.capabilities,
      maxAttempts,
      maxCost: effectiveMaxCost,
      maxConcurrency: requestedMaxConcurrency,
      totalSteps: workItems.length,
    },
    phases: phaseSummaries,
    workItems,
  };
}

/** Compile and durably instantiate a deterministic Fan-Out workflow into the Factory Work Graph. */
export async function instantiateFactoryFanoutWorkflow(input, actor, { assignments = null } = {}) {
  const proposal = compileFactoryFanoutWorkflow(input);
  const commandId = required(input.commandId, 'commandId');
  const key = required(input.idempotencyKey, 'idempotencyKey');
  const actorId = required(actor?.principalId, 'authenticated principal');
  const payloadDigest = digest({ templateId: proposal.templateId, templateVersion: proposal.templateVersion, inputDigest: proposal.inputDigest });
  return factoryTransaction((db) => {
    const org = authorize(db, proposal.goal.organizationId, actor, 'factory.CreateWorkItem');
    if (org.project_id !== proposal.goal.projectId) throw factoryError('FACTORY_CONFLICT', 'Project does not match organization');
    const existing = db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?')
      .get(actorId, 'InstantiateFanoutWorkflow', proposal.goal.organizationId, key);
    if (existing) {
      if (existing.payload_digest !== payloadDigest) throw factoryError('FACTORY_CONFLICT', 'Idempotency key reused with different inputs');
      return { ...JSON.parse(existing.result_json), replayed: true };
    }
    if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) {
      throw factoryError('FACTORY_CONFLICT', 'Command ID already used');
    }
    const result = instantiateFactoryWorkflowInTransaction(db, proposal, org, commandId, { assignments });
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)')
      .run(commandId, proposal.goal.organizationId, actorId, 'InstantiateFanoutWorkflow', proposal.goal.organizationId, key, payloadDigest, encode(result), now());
    return { ...result, proposal };
  });
}
