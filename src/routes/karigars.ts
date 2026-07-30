import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { requireTenantAuth } from '../middleware/auth';
import { encryptPassword, decryptPassword } from '../utils/passwordCrypto';

const router = Router();

router.use(requireTenantAuth());

// GET /api/karigars - List all karigars with login credentials
router.get('/', async (req: Request, res: Response) => {
  try {
    const karigars = await req.tenant!.models.Karigars.find().sort({ name: 1 });
    const users = await req.tenant!.models.User.find({ role: 'karigar' }).select('+passwordEncrypted');

    const userMap: Record<string, { username: string; password?: string }> = {};
    users.forEach((u) => {
      let pwd = '';
      if (u.passwordEncrypted) {
        try {
          pwd = decryptPassword(u.passwordEncrypted);
        } catch (e) {
          // ignore
        }
      }
      if (u.karigarRefId) {
        userMap[u.karigarRefId] = { username: u.username, password: pwd };
      }
    });

    const result = karigars.map((k) => {
      const obj = k.toJSON();
      const uInfo = userMap[k._id.toString()];
      if (uInfo) {
        if (!obj.username) (obj as any).username = uInfo.username;
        if (uInfo.password) (obj as any).password = uInfo.password;
      }
      return obj;
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/karigars/:id - Get single karigar
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const karigar = await req.tenant!.models.Karigars.findById(req.params.id);
    if (!karigar) return res.status(404).json({ error: 'Karigar not found' });
    const obj = karigar.toJSON();

    const user = await req.tenant!.models.User.findOne({ karigarRefId: karigar._id.toString() }).select('+passwordEncrypted');
    if (user) {
      if (!obj.username) (obj as any).username = user.username;
      if (user.passwordEncrypted) {
        try {
          (obj as any).password = decryptPassword(user.passwordEncrypted);
        } catch (e) {
          // ignore
        }
      }
    }

    res.json(obj);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/karigars - Create karigar + user account if username & password provided
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, mobile, companyName, email, category, specialty, gstNumber, address, note, pendingWeight, username, password } = req.body;

    if (!name || !mobile) {
      return res.status(400).json({ error: 'Name and mobile are required' });
    }

    const cleanUsername = username ? String(username).toLowerCase().trim() : '';

    if (cleanUsername) {
      if (!password || String(password).trim().length < 6) {
        return res.status(400).json({ error: 'Password (at least 6 characters) is required when enabling Karigar portal login.' });
      }

      const existingUser = await req.tenant!.models.User.findOne({ username: cleanUsername });
      if (existingUser) {
        return res.status(409).json({ error: `Username '${cleanUsername}' is already taken in this shop.` });
      }
    }

    // Create Karigar profile
    const karigar = await req.tenant!.models.Karigars.create({
      name,
      mobile,
      companyName,
      email,
      category,
      specialty,
      gstNumber,
      address,
      note,
      pendingWeight: Number(pendingWeight) || 0,
      username: cleanUsername || undefined,
    });

    // If username and password are provided, create matching login user
    if (cleanUsername && password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await req.tenant!.models.User.create({
        username: cleanUsername,
        passwordHash,
        passwordEncrypted: encryptPassword(password),
        name,
        role: 'karigar',
        karigarRefId: karigar._id.toString(),
        isActive: true,
      });
    }

    res.status(201).json(karigar.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/karigars/:id - Update karigar + user account
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, mobile, companyName, email, category, specialty, gstNumber, address, note, pendingWeight, username, password } = req.body;

    const karigar = await req.tenant!.models.Karigars.findById(req.params.id);
    if (!karigar) return res.status(404).json({ error: 'Karigar not found' });

    const cleanUsername = username !== undefined ? String(username).toLowerCase().trim() : (karigar.username || '');

    // Check if user exists for this karigar
    let user = await req.tenant!.models.User.findOne({ karigarRefId: karigar._id.toString() });

    if (cleanUsername) {
      const existingUser = await req.tenant!.models.User.findOne({
        username: cleanUsername,
        _id: { $ne: user?._id },
      });
      if (existingUser) {
        return res.status(409).json({ error: `Username '${cleanUsername}' is already taken.` });
      }
    }

    // Update Karigar document
    if (name !== undefined) karigar.name = name;
    if (mobile !== undefined) karigar.mobile = mobile;
    if (companyName !== undefined) karigar.companyName = companyName;
    if (email !== undefined) karigar.email = email;
    if (category !== undefined) karigar.category = category;
    if (specialty !== undefined) karigar.specialty = specialty;
    if (gstNumber !== undefined) karigar.gstNumber = gstNumber;
    if (address !== undefined) karigar.address = address;
    if (note !== undefined) karigar.note = note;
    if (pendingWeight !== undefined) karigar.pendingWeight = Number(pendingWeight) || 0;
    if (username !== undefined) karigar.username = cleanUsername || undefined;

    await karigar.save();

    // Sync User record
    if (cleanUsername) {
      if (user) {
        user.name = karigar.name;
        user.username = cleanUsername;
        if (password && String(password).trim().length >= 6) {
          user.passwordHash = await bcrypt.hash(password, 10);
          user.passwordEncrypted = encryptPassword(password);
        }
        await user.save();
      } else {
        // Create user record if not existed before
        if (!password || String(password).trim().length < 6) {
          return res.status(400).json({ error: 'Password (at least 6 characters) is required to create a login account for this karigar.' });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        await req.tenant!.models.User.create({
          username: cleanUsername,
          passwordHash,
          passwordEncrypted: encryptPassword(password),
          name: karigar.name,
          role: 'karigar',
          karigarRefId: karigar._id.toString(),
          isActive: true,
        });
      }
    }

    res.json(karigar.toJSON());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/karigars/:id - Delete karigar + user account
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const karigar = await req.tenant!.models.Karigars.findByIdAndDelete(req.params.id);
    if (!karigar) return res.status(404).json({ error: 'Karigar not found' });

    // Delete corresponding user login account if any
    await req.tenant!.models.User.deleteMany({ karigarRefId: req.params.id });

    res.json({ message: 'Karigar and user account deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
