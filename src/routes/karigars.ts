import { buildTenantCrudRouter } from './crudFactory';

/**
 * Karigar PROFILE data (name, mobile, specialty, pending weight, etc).
 *
 * Login credentials for karigars are no longer stored on this document -
 * unlike the original single-tenant app, which stored a plaintext
 * username/password directly on the Karigar record. In this SaaS version,
 * karigar logins live in the shop's own `User` collection (role: 'karigar',
 * bcrypt-hashed password) and are linked back here via `karigarRefId`.
 * See routes/tenantAuth.ts for creating a karigar login.
 */
export default buildTenantCrudRouter((models) => models.Karigars, {
  resourceName: 'Karigar',
  beforeCreate: (body) => {
    delete body.username;
    delete body.password;
    return body;
  },
  beforeUpdate: (body) => {
    delete body.username;
    delete body.password;
    return body;
  },
});
