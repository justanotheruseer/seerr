import type { SortOptions } from '@server/api/themoviedb';
import { SortOptionsIterable } from '@server/api/themoviedb';
import type {
  TmdbSearchMovieResponse,
  TmdbSearchTvResponse,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import { Blacklist } from '@server/entity/Blacklist';
import Media from '@server/entity/Media';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createTmdbWithRegionLanguage } from '@server/routes/discover';
import type { EntityManager } from 'typeorm';

const TMDB_API_DELAY_MS = 250;
class AbortTransaction extends Error {}

class BlacklistedTagProcessor implements RunnableScanner<StatusBase> {
  private running = false;
  private progress = 0;
  private total = 0;

  public async run() {
    this.running = true;

    try {
      await dataSource.transaction(async (em: EntityManager) => {
        await this.cleanBlacklist(em);
        await this.createBlacklistEntries(em);
      });
    } catch (err) {
      if (err instanceof AbortTransaction) {
        logger.info('Aborting job: Process Blacklisted Tags', {
          label: 'Jobs',
        });
      } else {
        throw err;
      }
    } finally {
      this.reset();
    }
  }

  public status(): StatusBase {
    return {
      running: this.running,
      progress: this.progress,
      total: this.total,
    };
  }

  public cancel() {
    this.running = false;
    this.progress = 0;
    this.total = 0;
  }

  private reset() {
    this.cancel();
  }

  private async createBlacklistEntries(em: EntityManager) {
    const tmdb = createTmdbWithRegionLanguage();

    const settings = getSettings();
    const blacklistedTags = settings.main.blacklistedTags || '';
    const blacklistedTagsArr = blacklistedTags
      ? blacklistedTags.split(',')
      : [];

    const pageLimit = settings.main.blacklistedTagsLimit;
    const invalidKeywords = new Set<string>();

    // Compute expected total work. Include tag-based queries if tags exist
    // and include the optional untagged movie scan when enabled.
    this.total = 0;
    if (blacklistedTagsArr.length > 0) {
      this.total +=
        2 * blacklistedTagsArr.length * pageLimit * SortOptionsIterable.length;
    }

    for (const type of [MediaType.MOVIE, MediaType.TV]) {
      const getDiscover =
        type === MediaType.MOVIE ? tmdb.getDiscoverMovies : tmdb.getDiscoverTv;

      // Iterate for each tag
      for (const tag of blacklistedTagsArr) {
        const keywordDetails = await tmdb.getKeywordDetails({
          keywordId: Number(tag),
        });

        if (keywordDetails === null) {
          logger.warn('Skipping invalid keyword in blacklisted tags', {
            label: 'Blacklisted Tags Processor',
            keywordId: tag,
          });
          invalidKeywords.add(tag);
          continue;
        }

        let queryMax = pageLimit * SortOptionsIterable.length;
        let fixedSortMode = false; // Set to true when the page limit allows for getting every page of tag

        for (let query = 0; query < queryMax; query++) {
          const page: number = fixedSortMode
            ? query + 1
            : (query % pageLimit) + 1;
          const sortBy: SortOptions | undefined = fixedSortMode
            ? undefined
            : SortOptionsIterable[query % SortOptionsIterable.length];

          if (!this.running) {
            throw new AbortTransaction();
          }

          try {
            const response = await getDiscover({
              page,
              sortBy,
              keywords: tag,
            });

            await this.processResults(response, tag, type, em);
            await new Promise((res) => setTimeout(res, TMDB_API_DELAY_MS));

            this.progress++;
            if (page === 1 && response.total_pages <= queryMax) {
              // We will finish the tag with less queries than expected, move progress accordingly
              this.progress += queryMax - response.total_pages;
              fixedSortMode = true;
              queryMax = response.total_pages;
            }
          } catch (error) {
            logger.error('Error processing keyword in blacklisted tags', {
              label: 'Blacklisted Tags Processor',
              keywordId: tag,
              errorMessage: error.message,
            });
          }
        }
      }
    }

    // Optionally blacklist movies that have no keywords/tags
    if (settings.main.blacklistUntaggedMovies) {
      try {
        // We'll scan discovery results for movies and check their keywords
        const untaggedPageLimit = pageLimit;
        const untaggedQueryMax = untaggedPageLimit * SortOptionsIterable.length;

        // Increase the expected total so progress reporting remains sensible
        this.total += untaggedQueryMax;

        for (let query = 0; query < untaggedQueryMax; query++) {
          if (!this.running) {
            throw new AbortTransaction();
          }

          const page: number = (query % untaggedPageLimit) + 1;
          const sortBy: SortOptions | undefined =
            SortOptionsIterable[query % SortOptionsIterable.length];

          const response = await tmdb.getDiscoverMovies({ page, sortBy });

          for (const entry of response.results) {
            if (!this.running) {
              throw new AbortTransaction();
            }

            try {
              // Get full movie details (includes keywords) and check if any keywords exist
              const movieDetails = await tmdb.getMovie({ movieId: entry.id });

              let keywordList: any[] = [];
              if (movieDetails && (movieDetails as any).keywords) {
                const kws = (movieDetails as any).keywords;
                if (Array.isArray(kws.results)) {
                  keywordList = kws.results;
                } else if (Array.isArray(kws.keywords)) {
                  keywordList = kws.keywords;
                }
              }

              if (!keywordList || keywordList.length === 0) {
                const blacklistRepository = em.getRepository(Blacklist);
                const blacklistEntry = await blacklistRepository.findOne({
                  where: { tmdbId: entry.id },
                });

                if (!blacklistEntry) {
                  await Blacklist.addToBlacklist(
                    {
                      blacklistRequest: {
                        mediaType: MediaType.MOVIE,
                        title: 'title' in entry ? entry.title : undefined,
                        tmdbId: entry.id,
                      },
                    },
                    em
                  );
                }
              }
            } catch (err) {
              logger.debug(
                'Error checking movie keywords for untagged blacklist',
                {
                  label: 'Blacklisted Tags Processor',
                  tmdbId: entry.id,
                  errorMessage: err.message,
                }
              );
            }
          }

          // Respect TMDB rate limits
          await new Promise((res) => setTimeout(res, TMDB_API_DELAY_MS));

          this.progress++;
        }
      } catch (err) {
        logger.error('Error while processing untagged movies for blacklist', {
          label: 'Blacklisted Tags Processor',
          errorMessage: err.message,
        });
      }
    }

    if (invalidKeywords.size > 0) {
      const currentTags = blacklistedTagsArr.filter(
        (tag) => !invalidKeywords.has(tag)
      );
      const cleanedTags = currentTags.join(',');

      if (cleanedTags !== blacklistedTags) {
        settings.main.blacklistedTags = cleanedTags;
        await settings.save();

        logger.info('Cleaned up invalid keywords from settings', {
          label: 'Blacklisted Tags Processor',
          removedKeywords: Array.from(invalidKeywords),
          newBlacklistedTags: cleanedTags,
        });
      }
    }
  }

  private async processResults(
    response: TmdbSearchMovieResponse | TmdbSearchTvResponse,
    keywordId: string,
    mediaType: MediaType,
    em: EntityManager
  ) {
    const blacklistRepository = em.getRepository(Blacklist);

    for (const entry of response.results) {
      const blacklistEntry = await blacklistRepository.findOne({
        where: { tmdbId: entry.id },
      });

      if (blacklistEntry) {
        // Don't mark manual blacklists with tags
        // If media wasn't previously blacklisted for this tag, add the tag to the media's blacklist
        if (
          blacklistEntry.blacklistedTags &&
          !blacklistEntry.blacklistedTags.includes(`,${keywordId},`)
        ) {
          await blacklistRepository.update(blacklistEntry.id, {
            blacklistedTags: `${blacklistEntry.blacklistedTags}${keywordId},`,
          });
        }
      } else {
        // Media wasn't previously blacklisted, add it to the blacklist
        await Blacklist.addToBlacklist(
          {
            blacklistRequest: {
              mediaType,
              title: 'title' in entry ? entry.title : entry.name,
              tmdbId: entry.id,
              blacklistedTags: `,${keywordId},`,
            },
          },
          em
        );
      }
    }
  }

  private async cleanBlacklist(em: EntityManager) {
    // Remove blacklist and media entries blacklisted by tags
    const mediaRepository = em.getRepository(Media);
    const mediaToRemove = await mediaRepository
      .createQueryBuilder('media')
      .innerJoinAndSelect(Blacklist, 'blist', 'blist.tmdbId = media.tmdbId')
      .where(`blist.blacklistedTags IS NOT NULL`)
      .getMany();

    // Batch removes so the query doesn't get too large
    for (let i = 0; i < mediaToRemove.length; i += 500) {
      await mediaRepository.remove(mediaToRemove.slice(i, i + 500)); // This also deletes the blacklist entries via cascading
    }
  }
}

const blacklistedTagsProcessor = new BlacklistedTagProcessor();

export default blacklistedTagsProcessor;
