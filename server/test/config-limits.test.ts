import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('sign-in limits', () => {
  it('allow an office behind one address 60 a minute, each account 10, and follow CT_LOGIN_RPM when it is higher', () => {
    expect(loadConfig({}, [])).toMatchObject({ loginRpm: 10, loginIpRpm: 60 });
    expect(loadConfig({ CT_LOGIN_RPM: '1000' }, [])).toMatchObject({ loginRpm: 1000, loginIpRpm: 2000 });
    expect(loadConfig({ CT_LOGIN_IP_RPM: '300' }, [])).toMatchObject({ loginRpm: 10, loginIpRpm: 300 });
  });
});
