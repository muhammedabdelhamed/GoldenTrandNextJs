interface ecommerceCategoryAttributes {
  id: string;
  name: string;
  slug: string;
  description: string;
  image?: string;
  status: boolean;
  createdAt?: Date;
  deletedAt?: Date;
  updatedAt?: Date;
}

type ecommerceCategoryPk = "id";
type ecommerceCategoryId = ecommerceCategory[ecommerceCategoryPk];
type ecommerceCategoryOptionalAttributes =
  | "id"
  | "image"
  | "status"
  | "createdAt"
  | "deletedAt"
  | "updatedAt";
type ecommerceCategoryCreationAttributes = Optional<
  ecommerceCategoryAttributes,
  ecommerceCategoryOptionalAttributes
>;
