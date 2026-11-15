import assert from 'node:assert/strict';
import { ownerIdentityPathForService } from '../lib/windows-owner-identity-paths.mjs';

const env = { ProgramData: 'D:\\Shared Data', RAGENT_INSTANCE_ROOT: 'd:\\shared data\\Ragent\\instances\\owner',
  RAGENT_CONFIG_DIR: 'D:\\Shared Data\\Ragent\\instances\\owner\\config' };
assert.equal(ownerIdentityPathForService(env), 'D:\\Shared Data\\Ragent\\instances\\owner\\config\\instance-identity.json');
assert.equal(ownerIdentityPathForService({ ...env, RAGENT_CONFIG_DIR: 'D:\\other' }), null);
assert.equal(ownerIdentityPathForService({ ...env, RAGENT_INSTANCE_ROOT: 'C:\\ProgramData\\Ragent\\instances\\owner' }), null);
assert.equal(ownerIdentityPathForService({ ...env, ProgramData: '\\\\server\\share' }), null);
assert.equal(ownerIdentityPathForService({ ...env, ProgramData: 'relative' }), null);
console.log('windows-owner-identity-paths: checks passed');
