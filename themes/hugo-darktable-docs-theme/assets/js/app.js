var lunrIndex;
var pagesIndex;
var pagesMap = {};
var SEARCH_RESULT_LIMIT = 20;
var SEARCH_RESULT_EXCERPT_LENGTH = 160;

function sanitizeRegex(src) {
    return src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Initialize lunrjs using our generated index file
function initLunr() {
    var request = new XMLHttpRequest();
    request.open('GET', indexURL, true);

    request.onload = function () {
        if (request.status >= 200 && request.status < 400) {
            pagesIndex = JSON.parse(request.responseText);
            console.log('index:', pagesIndex);

            pagesIndex.forEach(function (page) {
                pagesMap[page.href] = page;
            });

            // Set up lunrjs by declaring the fields we use
            // Also provide their boost level for the ranking
            lunrIndex = lunr(function () {
                this.pipeline.remove(lunr.stemmer);
                this.searchPipeline.remove(lunr.stemmer);

                this.field('title', { boost: 5 });
                this.field('content', { boost: 2 });
                this.field('tags', { boost: 1 });

                // ref is the result item identifier (I chose the page URL)
                this.ref('href');
                this.add({ field: 'test', text: 'hello' });
                for (var i = 0; i < pagesIndex.length; ++i) {
                    this.add(pagesIndex[i]);
                }
            });
        } else {
            var err = textStatus + ', ' + error;
            console.error('Error getting Hugo index flie:', err);
        }
    };

    request.send();
}

function search(queryString, limit) {
    var queryTerms = lunr.tokenizer(queryString);
    var searchResults = lunrIndex.query(function (query) {
        queryTerms.forEach(function (queryTerm) {
            // look for an exact match and apply a large positive boost
            query.term(queryTerm, {
                usePipeline: true,
                boost: 100,
            });

            // look for terms that start or end with queryTerm and apply a medium boost
            query.term(queryTerm, {
                usePipeline: false,
                boost: 5,
                wildcard:
                    lunr.Query.wildcard.LEADING | lunr.Query.wildcard.TRAILING,
            });

            // look for terms that match with an edit distance of 1 and apply a small boost
            query.term(queryTerm, {
                usePipeline: false,
                editDistance: 1,
                boost: 1,
            });
        });
    });

    // Sort results by relevance
    searchResults.sort((a, b) => b.score - a.score);

    searchResults = searchResults.slice(0, limit);

    return searchResults;
}

function highlightKeyword(sourceText, keyword, tag) {
    if (!tag) tag = 'mark';

    return sourceText.replace(new RegExp(keyword, 'ig'), function (match) {
        return '<' + tag + '>' + match + '</' + tag + '>';
    });
}

function getTextExcerpt(text, keyword, length) {
    if (!length) length = 80;

    var index = text.search(new RegExp(keyword, 'ig'));
    var excerpt = text;

    if (index === -1) excerpt = text.substring(0, length) + '...';

    var halfLength = Math.round(length / 2);
    var excerpt = text.substring(
        Math.max(0, index - halfLength),
        Math.min(text.length, index + halfLength)
    );

    if (index - halfLength > 0) excerpt = '...' + excerpt;
    if (index + halfLength < text.length) excerpt = excerpt + '...';

    return excerpt;
}

function renderResults(results) {
    var searchResults = document.getElementById('search-results');
    var $searchResults = $(searchResults);

    if (!results.length) {
        $searchResults.hide();
        return;
    }

    var resultsFragment = document.createDocumentFragment();
    // Only show the first twenty results
    results.forEach(function (result) {
        var page = pagesMap[result.ref];
        var matchedTerms = Object.keys(result.matchData.metadata)
            .map(sanitizeRegex)
            .join('|');
        var link = document.createElement('a');
        var title = document.createElement('b');
        var content = document.createElement('small');

        link.className = 'search-results__item';
        title.className = 'search-results__title';
        content.className = 'search-results__content';

        link.href = page.href;
        title.innerHTML = highlightKeyword(page.title, matchedTerms);
        content.innerHTML = highlightKeyword(
            getTextExcerpt(
                page.content,
                matchedTerms,
                SEARCH_RESULT_EXCERPT_LENGTH
            ),
            matchedTerms
        );

        link.appendChild(title);
        link.appendChild(content);

        resultsFragment.appendChild(link);
    });
    searchResults.appendChild(resultsFragment);
    $searchResults.show();
}

// index of the result chosen with the arrow keys, -1 for none
var selectedResult = -1;

function selectResult(index) {
    var $items = $('#search-results a');
    if (!$items.length) return;

    selectedResult = (index + $items.length) % $items.length;
    $items.removeClass('is-selected').attr('aria-selected', 'false');
    var item = $items.get(selectedResult);
    item.classList.add('is-selected');
    item.setAttribute('aria-selected', 'true');
    item.scrollIntoView({ block: 'nearest' });
}

function closeSearchResults() {
    selectedResult = -1;
    $('#search-results').empty().hide();
}

function handleSearchInput() {
    var query = $('#search-input').val();

    closeSearchResults();

    //trigger a search if a search term longer than two characters has been entered
    if (query.length < 2 || !lunrIndex) {
        return;
    }

    renderResults(search(query, SEARCH_RESULT_LIMIT));
}

// Put the cursor into the search field (opening it first on a small screen).
function focusSearch() {
    var input = document.getElementById('search-input');
    var $form = $('#dtSearch');
    if (!input) return;

    if (input.offsetParent === null) {
        // collapsed behind the search button; it is focused once it is open
        $form.collapse('show');
    } else {
        input.focus();
        input.select();
    }
}

$(document).ready(function () {
    var $searchInput = $('#search-input');
    var $searchResults = $('#search-results');

    $searchResults.hide();
    $searchInput.focus(function () {
        //load index file if it's not already been loaded
        if (!lunrIndex) {
            initLunr();
        } else {
            // show the results for a term that is still in the field
            handleSearchInput();
        }
    });

    $('#dtSearch').on('submit', function (e) {
        e.preventDefault();
    });

    $searchInput.keydown(function (e) {
        var $items = $('#search-results a');

        if (e.key === 'Escape') {
            closeSearchResults();
            $searchInput.val('').trigger('blur');
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectResult(selectedResult + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectResult(selectedResult <= 0 ? $items.length - 1 : selectedResult - 1);
        } else if (e.key === 'Enter') {
            //enter key pressed - go to the chosen result, or the first one
            e.preventDefault();
            var item = $items.get(selectedResult >= 0 ? selectedResult : 0);
            if (item) item.click();
        }
    });

    $searchInput.on('input', handleSearchInput);

    // Ctrl+K / Cmd+K anywhere, or "/" outside of a text field, jumps to the search
    $(document).on('keydown', function (e) {
        var inField = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            focusSearch();
        } else if (e.key === '/' && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            focusSearch();
        }
    });

    // a click anywhere else closes the results
    $(document).on('click', function (e) {
        if (!$(e.target).closest('#dtSearch').length) closeSearchResults();
    });

    // show the right modifier key in the hint
    if (/Mac|iPhone|iPad/.test(navigator.platform)) {
        $('.dt-search__hint').text('\u2318K');
    }
});

// Keep the CSS variable --dt-header-h in sync with the real height of the
// sticky header, so the columns below it never slide underneath.
$(document).ready(function () {
    var header = document.querySelector('header.dt-header');
    if (!header) return;

    function setHeaderHeight() {
        document.documentElement.style.setProperty('--dt-header-h', header.offsetHeight + 'px');
    }

    setHeaderHeight();
    if ('ResizeObserver' in window) {
        new ResizeObserver(setHeaderHeight).observe(header);
    } else {
        window.addEventListener('resize', setHeaderHeight);
    }
});

// Small screens: the chapters are a drawer that slides in from the left,
// the search field is collapsed behind a button.
$(document).ready(function () {
    var $body = $('body');
    var $button = $('#dtMenuButton');
    var $search = $('#dtSearch');
    var chapters = document.getElementById('dtChapters');

    function setMenu(open) {
        $body.toggleClass('dt-menu-open', open);
        $button.attr('aria-expanded', open ? 'true' : 'false');
        if (open) {
            // only one of the two is open at a time
            $search.collapse('hide');
            // bring the current page into view
            var active = chapters && chapters.querySelector('a.active');
            if (active) active.scrollIntoView({ block: 'center' });
        }
    }

    $button.on('click', function () {
        setMenu(!$body.hasClass('dt-menu-open'));
    });
    $('#dtBackdrop').on('click', function () { setMenu(false); });
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && $body.hasClass('dt-menu-open')) {
            setMenu(false);
            $button.trigger('focus');
        }
    });
    // leaving the small-screen layout (rotation, resized window) closes the drawer
    if (window.matchMedia) {
        var wide = window.matchMedia('(min-width: 768px)');
        var onChange = function (e) { if (e.matches) setMenu(false); };
        if (wide.addEventListener) wide.addEventListener('change', onChange);
        else wide.addListener(onChange);
    }

    $search.on('show.bs.collapse', function () { setMenu(false); });
    $search.on('shown.bs.collapse', function () {
        $('#search-input').trigger('focus');
    });
    $search.on('hide.bs.collapse', closeSearchResults);
});

// "On this page": the title leads back to the top of the page.
$(document).ready(function () {
    $('.dt-toc__title').on('click', function (e) {
        e.preventDefault();
        window.scrollTo(0, 0);
        // drop a "#section" from the address without adding a history entry
        if (window.history && history.replaceState) {
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    });
});

// "On this page": mark the section that is currently in view.
$(document).ready(function () {
    var links = document.querySelectorAll('.dt-toc a[href^="#"]');
    if (!links.length) return;

    var entries = [];
    links.forEach(function (link) {
        var id = decodeURIComponent(link.getAttribute('href').slice(1));
        var heading = document.getElementById(id);
        if (heading) entries.push({ link: link, heading: heading });
    });
    if (!entries.length) return;

    var header = document.querySelector('header.dt-header');
    var ticking = false;

    function update() {
        ticking = false;
        var offset = (header ? header.offsetHeight : 0) + 24;
        var current = entries[0];
        entries.forEach(function (entry) {
            if (entry.heading.getBoundingClientRect().top <= offset) {
                current = entry;
            }
        });
        // at the very bottom of the page the last section wins
        if (window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 2) {
            current = entries[entries.length - 1];
        }
        entries.forEach(function (entry) {
            entry.link.classList.toggle('is-current', entry === current);
        });
    }

    window.addEventListener('scroll', function () {
        if (!ticking) {
            ticking = true;
            window.requestAnimationFrame(update);
        }
    }, { passive: true });
    window.addEventListener('resize', update);
    update();
});
