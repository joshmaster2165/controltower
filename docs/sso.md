# Single sign-on

**Enterprise:** single sign-on needs a [Control Tower Enterprise](enterprise.md) license.

People can sign in to the console through your identity provider, anything that speaks OpenID Connect: Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, Ping, JumpCloud. Their groups at the provider decide their [role](people.md) here: admin, approver or viewer. Every sign-in, and every refused one, goes into the [audit log](audit.md).

## Set it up

1. **Set `CT_PUBLIC_URL`** to the address people use for the console, such as `https://controltower.example.com`. The identity provider sends people back there, so it must be the public address, not an internal one.
2. **People → Single sign-on → + Identity provider.** The form shows the **sign-in redirect URL** to register at your provider, `https://controltower.example.com/admin/sso/<id>/callback`. After you save, each provider's own URL is shown when you edit it.
3. **At your identity provider,** create an OpenID Connect *web* application:
   - sign-in redirect URL: the one above;
   - grant type: authorization code;
   - scopes: `openid email profile`, plus whatever puts groups in the ID token (see [Groups](#groups-and-roles)).

   Copy its issuer URL, client ID and client secret back into Control Tower.
4. **Test** checks that Control Tower can reach the provider and read its settings (`<issuer>/.well-known/openid-configuration`).
5. The sign-in page now shows **Sign in with *name***.

| Setting | |
|---|---|
| Name on the sign-in page | What the button says: "Sign in with Okta" |
| Issuer URL | For example `https://acme.okta.com`, `https://login.microsoftonline.com/<tenant-id>/v2.0`, `https://accounts.google.com`, `https://acme.us.auth0.com/`, `https://sso.acme.com/realms/main`. Must be https |
| Client ID, client secret | From the app you created. The secret is stored encrypted, like provider credentials |
| Client authentication | How Control Tower proves itself to the token endpoint: client secret in the `Authorization` header (basic, the default), in the form (post), or none for a public client (PKCE only) |
| Email domains allowed | Only these email domains may sign in. Empty allows any address the provider vouches for |
| Groups claim, and admin, approver and viewer groups | See below |
| Anyone else | The role for someone in none of the groups: viewer, approver, admin, or **refused** |
| Create people on first sign-in | On: someone who passes the checks above is added with their role the first time they sign in. Off: only people an admin already [added](people.md#adding-people) by email get in |

## Groups and roles

Set **Groups claim** to the ID-token claim that lists someone's groups (usually `groups`). Then list the groups for each role. Someone in several gets the highest role (admin, then approver, then viewer). Someone in none gets the **Anyone else** role, or is refused.

With a groups claim set, the provider decides roles at every sign-in. Moving someone to another group changes their role the next time they sign in, and ends their other sessions. Leave the groups claim empty to manage roles in Control Tower instead: the **Anyone else** role applies when someone is first created, and an admin changes it from then on.

Putting groups in the ID token:

| Provider | How |
|---|---|
| Okta | On the app's **Sign On** tab, add a **Groups claim** named `groups`, filtered (e.g. *Starts with* `ct-`) |
| Microsoft Entra ID | Token configuration → **Add groups claim**. Entra sends group *IDs* (GUIDs), so list the IDs here. Very large memberships are left out of the token |
| Google Workspace | Google doesn't put groups in ID tokens. Use **Anyone else** with *Create people on first sign-in* off, and add people and roles in Control Tower |
| Auth0 | An Action that adds `event.authorization.roles` (or groups) to the ID token under a namespaced claim; set **Groups claim** to that name, such as `https://acme.com/groups`. Dotted names read nested claims |
| Keycloak | A **Group Membership** mapper on the client, claim name `groups`, *Full group path* off |

## Who gets in

A sign-in is refused, and the reason is shown and recorded, when:
- the provider refuses or the person cancels;
- the email isn't in an allowed domain, or the provider says it isn't verified;
- the person is in none of the groups and **Anyone else** is *refused*;
- they haven't been added, and new people aren't created from this provider;
- the email already signs in through a *different* identity. Someone else at the provider can't take over an existing person's account by claiming their address.

Someone an admin added by email is linked to their provider identity the first time they sign in with it. From then on they're recognised by that identity, even if their email changes. People created by single sign-on have no password; an admin can still give them a one-time password.

## Security

- The sign-in uses the authorization code flow with PKCE, plus `state` and `nonce`. The state travels in a short-lived (10 minute) encrypted cookie that works only for the sign-in callback. A callback can't be replayed, and a stolen or altered state is refused.
- The ID token's issuer, audience, expiry and nonce are checked, and so is its signature, against the keys the provider publishes. The OIDC spec allows skipping the signature for tokens fetched directly over TLS; Control Tower checks both.
- Issuers must use https. Plain http is allowed only for a provider on the same machine (`localhost`), for development.
- Sign-in attempts are limited per address (three times `CT_LOGIN_RPM` a minute).

## Only single sign-on

**Only single sign-on: turn passwords off** makes everyone sign in through the identity provider, and ends existing password sessions.

- **It needs `CT_ADMIN_KEY`.** The admin key keeps working as a sign-in (as `admin`) and as a bearer token, which is how you get back in if the identity provider is down or misconfigured.
- **You must have used it.** An admin can only turn it on after signing in with single sign-on themselves (or with the admin key), so nobody turns passwords off without knowing SSO works.
- **The last provider can't be removed** while it's on.
- **Turning it off from outside the console:**

```bash
curl -X PUT -H "Authorization: Bearer $CT_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"sso_only": false}' https://controltower.example.com/admin/api/sso/settings
```

## API

Admins only, except `GET /admin/api/sso`, which the sign-in page reads without signing in.

| Method | Path | |
|---|---|---|
| GET | `/admin/api/sso` | `{providers: [{id, name}], sso_only}`: what the sign-in page offers |
| GET, POST | `/admin/api/identity-providers` | List, with each provider's redirect URL, `sso_only` and `admin_key_set`; add one: `{name, issuer, client_id, client_secret, allowed_domains, groups_claim, role_map: {admin: [...], approver: [...], viewer: [...]}, default_role, create_users, token_auth}` |
| PATCH, DELETE | `/admin/api/identity-providers/:id` | Change (also `enabled`) or remove. Removing unlinks the people who signed in with it |
| POST | `/admin/api/identity-providers/:id/test` | Load the provider's discovery document |
| PUT | `/admin/api/sso/settings` | `{sso_only: true | false}` |
| GET | `/admin/sso/:id/start`, `/admin/sso/:id/callback` | The browser sign-in itself |

Refused sign-ins come back to the sign-in page as `/?sso_error=<reason>`. A password sign-in while passwords are off answers `403 sso_required`.
