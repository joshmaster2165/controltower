import { describe, expect, it } from 'vitest';
import { groupsFrom, issuerProblem, roleFor } from '../src/ee/oidc.js';

describe('single sign-on roles', () => {
  const p = { roleMap: { admin: ['ct-admins'], approver: ['security', 'ct-approvers'], viewer: ['eng'] }, defaultRole: 'none' as const };
  it('gives the highest role any of their groups maps to, or the default', () => {
    expect(roleFor(p, ['eng', 'security'])).toBe('approver');
    expect(roleFor(p, ['eng', 'ct-admins'])).toBe('admin');
    expect(roleFor(p, ['marketing'])).toBeUndefined();
    expect(roleFor({ ...p, defaultRole: 'viewer' }, [])).toBe('viewer');
  });
  it('reads groups from arrays, strings, namespaced and nested claims', () => {
    expect(groupsFrom({ groups: ['a', 'b', 3] }, 'groups')).toEqual(['a', 'b']);
    expect(groupsFrom({ groups: 'a, b c' }, 'groups')).toEqual(['a', 'b c']);
    expect(groupsFrom({ groups: 'Domain Admins' }, 'groups')).toEqual(['Domain Admins']); // one group, spaces and all
    expect(groupsFrom({ 'https://acme.com/groups': ['ct-admins'] }, 'https://acme.com/groups')).toEqual(['ct-admins']);
    expect(groupsFrom({ realm_access: { roles: ['ct-admins'] } }, 'realm_access.roles')).toEqual(['ct-admins']);
    expect(groupsFrom({ groups: ['a'] }, undefined)).toEqual([]);
  });
  it('wants https issuers, except on this machine', () => {
    expect(issuerProblem('https://acme.okta.com')).toBeUndefined();
    expect(issuerProblem('http://localhost:8080/realms/x')).toBeUndefined();
    expect(issuerProblem('http://idp.example.com')).toContain('https');
    expect(issuerProblem('not a url')).toContain('URL');
  });
});
