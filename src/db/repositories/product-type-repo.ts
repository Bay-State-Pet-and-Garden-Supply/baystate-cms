import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface ProductType {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTypeField {
  id: string;
  productTypeId: string;
  xmlField: string;
  label: string;
  dataType: string;
  required: boolean;
  validationRulesJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTypeDetail extends ProductType {
  fields: ProductTypeField[];
}

export function listProductTypes(workspaceId: string): ProductType[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM product_types WHERE workspace_id = ? ORDER BY name ASC').all(workspaceId) as Record<string, any>[];
  return rows.map(mapTypeRow);
}

export function getProductType(id: string): ProductTypeDetail | null {
  const db = getDb();
  const typeRow = db.query('SELECT * FROM product_types WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!typeRow) return null;

  const fieldRows = db.query('SELECT * FROM product_type_fields WHERE product_type_id = ? ORDER BY xml_field ASC').all(id) as Record<string, any>[];
  
  return {
    ...mapTypeRow(typeRow),
    fields: fieldRows.map(mapFieldRow),
  };
}

export function createProductType(workspaceId: string, name: string): ProductType {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO product_types (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, workspaceId, name, now, now]
  );
  return { id, workspaceId, name, createdAt: now, updatedAt: now };
}

export function deleteProductType(id: string): void {
  const db = getDb();
  // Foreign keys are enabled, so deleting a product_type will delete associated fields if CASCADE is defined,
  // but to be safe and clean, we delete both.
  db.run('DELETE FROM product_type_fields WHERE product_type_id = ?', [id]);
  db.run('DELETE FROM product_types WHERE id = ?', [id]);
}

export function upsertProductTypeField(field: Omit<ProductTypeField, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ProductTypeField {
  const db = getDb();
  const id = field.id ?? randomUUID();
  const now = new Date().toISOString();
  
  db.run(
    `INSERT INTO product_type_fields (id, product_type_id, xml_field, label, data_type, required, validation_rules_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_type_id, xml_field) DO UPDATE SET
       label = EXCLUDED.label,
       data_type = EXCLUDED.data_type,
       required = EXCLUDED.required,
       validation_rules_json = EXCLUDED.validation_rules_json,
       updated_at = EXCLUDED.updated_at`,
    [
      id, field.productTypeId, field.xmlField, field.label, field.dataType,
      field.required ? 1 : 0, field.validationRulesJson, now, now
    ]
  );

  return {
    id,
    productTypeId: field.productTypeId,
    xmlField: field.xmlField,
    label: field.label,
    dataType: field.dataType,
    required: field.required,
    validationRulesJson: field.validationRulesJson,
    createdAt: now,
    updatedAt: now
  };
}

export function deleteProductTypeField(productTypeId: string, xmlField: string): void {
  const db = getDb();
  db.run('DELETE FROM product_type_fields WHERE product_type_id = ? AND xml_field = ?', [productTypeId, xmlField]);
}

function mapTypeRow(row: Record<string, any>): ProductType {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFieldRow(row: Record<string, any>): ProductTypeField {
  return {
    id: String(row.id),
    productTypeId: String(row.product_type_id),
    xmlField: String(row.xml_field),
    label: String(row.label),
    dataType: String(row.data_type),
    required: Number(row.required) === 1,
    validationRulesJson: row.validation_rules_json ? String(row.validation_rules_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
