import PocketBase, { RecordService } from 'pocketbase';
import { createContext } from 'react';

export const pb = new PocketBase(window.location.origin);

pb.autoCancellation(false);

type RecordModel = {
  id: string;
  created: string;
  updated: string;
  collectionId: string;
  collectionName: string;
};

export type User = RecordModel & {
  username: string;
  email: string;
  name: string;
  avatar: string;
};

export const usersCollection = pb.collection('users') as RecordService<User>;

export type Tag = RecordModel & {
  name: string;
  games: string[];
  description: string;
} & {
  expand?: {
    tag_categories_via_tags?: [TagCategory];
  };
};

export const tagsCollection = pb.collection('tags') as RecordService<Tag>;

export type TagCategory = RecordModel & {
  name: string;
  allow_new_tags: boolean;
  min_tags: number;
  max_tags: number;
  tags: string[];
  description: string;
} & {
  expand?: {
    tags?: Tag[];
  };
};

export const tagCategoriesCollection = pb.collection('tag_categories') as RecordService<TagCategory>;

export type Game = RecordModel & {
  title: string;
  description: string;
  image: string;
  tags: string[];
  img_or_link: 'img' | 'link';
  iframe_url: string;
  cyoa_pages: string[];
  upvotes: string[];
  comments: string[];
} & {
  expand?: {
    tags?: Tag[];
    authors_via_games?: Author[];
    upvotes?: User[];
    comments?: Comment[];
  };
};

export const gamesCollection = pb.collection('games') as RecordService<Game>;

export type Comment = RecordModel & {
  content: string;
  author: string;
  children: string[];
} & {
  expand?: {
    author?: User;
    children?: Comment[];
  };
};

export const commentsCollection = pb.collection('comments') as RecordService<Comment>;

export type Author = RecordModel & {
  name: string;
  description: string;
  games: string[];
} & {
  expand?: {
    games?: Game[];
  };
};

export const authorsCollection = pb.collection('authors') as RecordService<Author>;

type Provider = 'discord';

export async function register(args: { username: string; email?: string; password: string } | { provider: Provider }) {
  if ('password' in args) {
    await usersCollection.create({
      username: args.username,
      email: args.email,
      name: args.username,
      password: args.password,
      passwordConfirm: args.password,
    });
  } else {
    await usersCollection.authWithOAuth2({ provider: args.provider });
  }
}

export async function login(args: { usernameOrEmail: string; password: string } | { provider: Provider }) {
  if ('password' in args) {
    await usersCollection.authWithPassword(args.usernameOrEmail, args.password);
  } else {
    await usersCollection.authWithOAuth2({ provider: args.provider });
  }
}

export const AuthContext = createContext({ signedIn: false, user: null as User | null });
