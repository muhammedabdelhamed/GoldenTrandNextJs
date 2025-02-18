import * as Sequelize from "sequelize";
import { DataTypes, Model } from "sequelize";
import user from "./user";
import post from "./post";

export default class comment
  extends Model<commentAttributes, commentCreationAttributes>
  implements commentAttributes
{
  id!: string;
  content!: string;
  userId!: string;
  postId!: string;
  createdAt?: Date;
  deletedAt?: Date;
  updatedAt?: Date;

  // comment belongsTo user via userId
  user!: user;
  getUser!: Sequelize.BelongsToGetAssociationMixin<user>;
  setUser!: Sequelize.BelongsToSetAssociationMixin<user, userId>;
  createUser!: Sequelize.BelongsToCreateAssociationMixin<user>;
  // comment belongsTo post via postId
  post!: post;
  getPost!: Sequelize.BelongsToGetAssociationMixin<post>;
  setPost!: Sequelize.BelongsToSetAssociationMixin<post, postId>;
  createPost!: Sequelize.BelongsToCreateAssociationMixin<post>;

  public static initModel(sequelize: Sequelize.Sequelize): typeof comment {
    return comment.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: false,
          validate: {
            notEmpty: { msg: "content: Content must not be empty" },
          },
        },
        userId: {
          type: DataTypes.UUID,
          allowNull: false,

          validate: {
            notNull: { msg: "userId: User ID cannot be null" },
            isUUID: {
              args: 4,
              msg: "userId: User ID must be a valid UUID",
            },
          },
        },
        postId: {
          type: DataTypes.UUID,
          allowNull: false,

          validate: {
            notNull: { msg: "postId: Post ID cannot be null" },
            isUUID: { args: 4, msg: "postId: Post ID must be a valid UUID" },
          },
        },
      },
      {
        sequelize,
        modelName: "comment",
        tableName: "comment",
        timestamps: true,
        paranoid: true,
        indexes: [
          {
            name: "PRIMARY",
            unique: true,
            using: "BTREE",
            fields: [{ name: "id" }],
          },
          {
            name: "commentsPostIdForeign",
            using: "BTREE",
            fields: [{ name: "postId" }],
          },
          {
            name: "commentsUserIdForeign",
            using: "BTREE",
            fields: [{ name: "userId" }],
          },
        ],
      }
    );
  }
  public static associate(models: any) {
    comment.belongsTo(models.user, {
      as: "user",
      foreignKey: "userId",
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    });
    comment.belongsTo(models.post, {
      as: "post",
      foreignKey: "postId",
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    });
  }
}
