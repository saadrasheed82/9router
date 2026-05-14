import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { mirrorLocalWrite } from "../hooks/cloudSyncHooks.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
  mirrorLocalWrite({ localTable: "modelAliases", recordId: alias, eventType: "UPDATE", version: Date.now(), payload: { alias, targetModel: model } }).catch(() => {});
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  mirrorLocalWrite({ localTable: "modelAliases", recordId: alias, eventType: "DELETE", version: Date.now(), payload: { alias } }).catch(() => {});
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races
export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) return;
    const value = stringifyJson({ providerAlias, id, type, name: name || id });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  if (added) {
    mirrorLocalWrite({ localTable: "customModels", recordId: `${providerAlias}|${id}|${type}`, eventType: "INSERT", version: Date.now(), payload: { providerAlias, id, type, name: name || id } }).catch(() => {});
  }
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
  mirrorLocalWrite({ localTable: "customModels", recordId: `${providerAlias}|${id}|${type}`, eventType: "DELETE", version: Date.now(), payload: { providerAlias, id, type } }).catch(() => {});
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
  mirrorLocalWrite({ localTable: "modelAliases", recordId: `mitm:${toolName}`, eventType: "UPDATE", version: Date.now(), payload: { toolName, mappings } }).catch(() => {});
}
