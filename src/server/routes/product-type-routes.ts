import { Hono } from 'hono';
import {
  listProductTypes,
  getProductType,
  createProductType,
  deleteProductType,
  upsertProductTypeField,
  deleteProductTypeField,
} from '../../db/repositories/product-type-repo';
import { getCurrentWorkspace } from '../../server/services/workspace-service';

const router = new Hono();

// List all product types for active workspace
router.get('/product-types', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }
  const types = listProductTypes(ws.id);
  return c.json({ types });
});

// Get detailed product type with fields
router.get('/product-types/:id', async (c) => {
  const id = c.req.param('id');
  const typeDetail = getProductType(id);
  if (!typeDetail) {
    return c.json({ error: 'Product type not found' }, 404);
  }
  return c.json({ productType: typeDetail });
});

// Create product type
router.post('/product-types', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }
  const body = await c.req.json();
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'Name is required and must be a string' }, 400);
  }
  const newType = createProductType(ws.id, body.name);
  return c.json({ success: true, productType: newType });
});

// Delete product type
router.delete('/product-types/:id', async (c) => {
  const id = c.req.param('id');
  const typeDetail = getProductType(id);
  if (!typeDetail) {
    return c.json({ error: 'Product type not found' }, 404);
  }
  deleteProductType(id);
  return c.json({ success: true });
});

// Upsert field mapping to a product type
router.post('/product-types/:id/fields', async (c) => {
  const productTypeId = c.req.param('id');
  const typeDetail = getProductType(productTypeId);
  if (!typeDetail) {
    return c.json({ error: 'Product type not found' }, 404);
  }

  const body = await c.req.json();
  if (!body.xmlField || !body.label || !body.dataType) {
    return c.json({ error: 'xmlField, label, and dataType are required' }, 400);
  }

  const field = upsertProductTypeField({
    productTypeId,
    xmlField: body.xmlField,
    label: body.label,
    dataType: body.dataType,
    required: !!body.required,
    validationRulesJson: body.validationRulesJson ? JSON.stringify(body.validationRulesJson) : null,
  });

  return c.json({ success: true, field });
});

// Delete field mapping from a product type
router.delete('/product-types/:id/fields/:xmlField', async (c) => {
  const productTypeId = c.req.param('id');
  const xmlField = c.req.param('xmlField');
  
  const typeDetail = getProductType(productTypeId);
  if (!typeDetail) {
    return c.json({ error: 'Product type not found' }, 404);
  }

  deleteProductTypeField(productTypeId, xmlField);
  return c.json({ success: true });
});

export default router;
