import { Router, Request, Response } from 'express';
import { Model } from 'mongoose';
import { TenantModels } from '../models/tenant/registerTenantModels';
import { requireTenantAuth } from '../middleware/auth';

type ModelPicker = (models: TenantModels) => Model<any>;

interface CrudOptions {
  /** Field to sort by descending, default 'createdAt' */
  sortField?: string;
  /** Roles allowed to read (GET). Default: any authenticated tenant user. */
  readRoles?: Array<'owner' | 'operator' | 'karigar'>;
  /** Roles allowed to write (POST/PUT/DELETE). Default: owner + operator. */
  writeRoles?: Array<'owner' | 'operator' | 'karigar'>;
  /** Hook to transform/sanitize the request body before create. */
  beforeCreate?: (body: any) => any;
  /** Hook to transform/sanitize the request body before update. */
  beforeUpdate?: (body: any) => any;
  /** Hook to mutate/clean a document before sending to the client. */
  serialize?: (doc: any) => any;
  resourceName: string;
}

/**
 * Builds a standard REST CRUD router (GET list, GET by id, POST, PUT, DELETE)
 * bound to whichever model `pickModel` selects from req.tenant.models.
 *
 * Every route is wrapped in requireTenantAuth, so req.tenant.models is
 * GUARANTEED to be scoped to the caller's own shop database - there is no
 * code path here that can read or write another tenant's data.
 */
export function buildTenantCrudRouter(pickModel: ModelPicker, options: CrudOptions): Router {
  const router = Router();
  const {
    sortField = 'createdAt',
    readRoles,
    writeRoles = ['owner', 'operator'],
    beforeCreate,
    beforeUpdate,
    serialize,
    resourceName,
  } = options;

  const ser = (doc: any) => {
    const obj = doc.toJSON ? doc.toJSON() : doc;
    return serialize ? serialize(obj) : obj;
  };

  router.get('/', requireTenantAuth(readRoles), async (req: Request, res: Response) => {
    try {
      const Model = pickModel(req.tenant!.models);
      const docs = await Model.find().sort({ [sortField]: -1 });
      res.json(docs.map(ser));
    } catch (error: any) {
      res.status(500).json({ error: `Failed to fetch ${resourceName}` });
    }
  });

  router.get('/:id', requireTenantAuth(readRoles), async (req: Request, res: Response) => {
    try {
      const Model = pickModel(req.tenant!.models);
      const doc = await Model.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: `${resourceName} not found` });
      res.json(ser(doc));
    } catch (error: any) {
      res.status(500).json({ error: `Failed to fetch ${resourceName}` });
    }
  });

  router.post('/', requireTenantAuth(writeRoles), async (req: Request, res: Response) => {
    try {
      const Model = pickModel(req.tenant!.models);
      const body = beforeCreate ? beforeCreate({ ...req.body }) : { ...req.body };
      delete body.id;
      delete body._id;
      const doc = new Model(body);
      await doc.save();
      res.status(201).json(ser(doc));
    } catch (error: any) {
      res.status(400).json({ error: error.message || `Failed to create ${resourceName}` });
    }
  });

  router.put('/:id', requireTenantAuth(writeRoles), async (req: Request, res: Response) => {
    try {
      const Model = pickModel(req.tenant!.models);
      const body = beforeUpdate ? beforeUpdate({ ...req.body }) : { ...req.body };
      delete body.id;
      delete body._id;
      const doc = await Model.findByIdAndUpdate(req.params.id, body, {
        new: true,
        runValidators: true,
      });
      if (!doc) return res.status(404).json({ error: `${resourceName} not found` });
      res.json(ser(doc));
    } catch (error: any) {
      res.status(400).json({ error: error.message || `Failed to update ${resourceName}` });
    }
  });

  router.delete('/:id', requireTenantAuth(writeRoles), async (req: Request, res: Response) => {
    try {
      const Model = pickModel(req.tenant!.models);
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ error: `${resourceName} not found` });
      res.json({ message: `${resourceName} deleted` });
    } catch (error: any) {
      res.status(500).json({ error: `Failed to delete ${resourceName}` });
    }
  });

  return router;
}
