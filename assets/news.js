// Renders news.yaml into #news-list.
// Optional attributes on #news-list:
//   data-limit="6"        only show the newest N items (homepage)
//   data-group="year"     add a heading for each year (news page)
document.addEventListener('DOMContentLoaded', () => {
    const newsList = document.getElementById('news-list');
    if (!newsList) return;
    fetch('news.yaml')
        .then(response => response.text())
        .then(yamlText => {
            const news = jsyaml.load(yamlText);
            const limit = parseInt(newsList.dataset.limit, 10);
            renderNews(newsList, limit ? news.slice(0, limit) : news, newsList.dataset.group === 'year');
        })
        .catch(error => {
            console.error('Error fetching or parsing news:', error);
            newsList.innerHTML = '<p>Could not load news updates.</p>';
        });
});

function renderNews(newsList, newsItems, groupByYear) {
    newsList.innerHTML = '';
    let currentYear = null;

    newsItems.forEach(item => {
        const date = new Date(item.date);
        const formattedDate = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        if (groupByYear && date.getFullYear() !== currentYear) {
            currentYear = date.getFullYear();
            const heading = document.createElement('h2');
            heading.className = 'news-year';
            heading.textContent = currentYear;
            newsList.appendChild(heading);
        }

        const newsItem = document.createElement('div');
        newsItem.className = 'news-item';
        let linksHTML = '';
        if (item.links && item.links.length > 0) {
            linksHTML = '<div class="news-links">' +
                item.links.map(link =>
                    `<a href="${link.url}" class="news-link" target="_blank">
                        <i class="fas fa-external-link-alt"></i>${link.text}
                    </a>`
                ).join('') +
                '</div>';
        }

        // Get the appropriate icon based on type
        const getIcon = (type) => {
            switch(type) {
                case 'publication':
                    return 'fa-scroll';
                case 'talk':
                    return 'fa-microphone';
                case 'job':
                    return 'fa-briefcase';
                case 'award':
                    return 'fa-trophy';
                default:
                    return 'fa-circle-info';
            }
        };

        newsItem.innerHTML = `
            <div class="news-header">
                <span class="news-icon icon-${item.type}">
                    <i class="fas ${getIcon(item.type)}"></i>
                </span>
                <div class="news-date">${formattedDate}</div>
            </div>
            <div class="news-content">
                ${item.content}
                <div style="margin-top: 0.2rem;">
                    ${item.location ? `<span class="news-location"><i class="fas fa-location-dot" style="position:relative; top:1px"></i> ${item.location}</span>` : ''}
                    ${linksHTML ? linksHTML : ''}
                </div>
            </div>
        `;
        newsList.appendChild(newsItem);
    });
}
