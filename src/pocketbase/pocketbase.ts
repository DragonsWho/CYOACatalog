// src/pocketbase/pocketbase.ts
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
  isModerator: boolean;
  blocked_tags?: string[];
  blocked_tags_customized?: boolean; // <--- ДОБАВЛЕНО ПОЛЕ
} & {
  expand?: {
    blocked_tags?: Tag[];
  };
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

export type GameTagVote = RecordModel & {
  gameId: string;
  tagId: string;
  votes: number;
  upVoters: string[];
  downVoters: string[];
};

export const gameTagVotesCollection = pb.collection('game_tag_votes') as RecordService<GameTagVote>;

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
  cyoa_pages_preview: string[];
  tags: string[];
  img_or_link: 'img' | 'link';
  iframe_url: string;
  cyoa_pages: string[];
  upvotes: string[]; // Оставляем для проверки isUpvoted
  upvotes_count?: number; // <--- ДОБАВЛЕНО: Необязательное поле для счетчика
  comments: string[];
  comments_count?: number;
  uploader: string;
  image_base64?: string;
} & {
  expand?: {
    tags?: Tag[];
    authors_via_games?: Author[];
    upvotes?: User[]; // Это expand для самих User объектов, если нужно
    comments?: Comment[];
  };
};

export const gamesCollection = pb.collection('games') as RecordService<Game>;

export type Comment = RecordModel & {
  content: string;
  author: string;
  children: string[];
  parent: string;
  game?: string;  
} & {
  expand?: {
    author?: User;
    children?: Comment[];
    game?: Game;  
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


export type GameRelationship = RecordModel & {
  source_game: string;
  target_game: string;
  relationship_type: 'Translation' | 'Expansion' | 'Sequel' | 'Interactive Port' | 'Static Port' | 'DLC' | 'Inspired By';
  order_in_series?: number;
  source_language?: string;
  target_language?: string;
  description_source?: string;
  description_target?: string;
} & {
  expand?: {
    source_game?: Game;
    target_game?: Game;
  };
};

export const gameRelationshipsCollection = pb.collection('game_relationships') as RecordService<GameRelationship>;
 

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

export const AuthContext = createContext({
  signedIn: false,
  user: null as User | null,
  isModerator: false,
  blockedTags: [] as Tag[], // Добавляем массив заблокированных тегов (объекты Tag)
});